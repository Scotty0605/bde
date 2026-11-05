-- =====================================================================
--  BDE — Renforcement de la sécurité
--  (déjà inclus à la fin de schema.sql ; ce fichier sert à mettre à jour
--   une base existante. Peut être relancé sans risque.)
--
--  1. Validation des comptes : un nouveau compte est « en attente » et ne
--     voit rien tant que le président (propriétaire) ne l'a pas accepté.
--  2. Vue d'ensemble restreinte : certains pôles (Présidence, Trésorerie)
--     sont cachés au rôle « vue d'ensemble ».
--  3. Double authentification : les membres d'un pôle marqué « 2FA
--     obligatoire » (Trésorerie) n'y accèdent qu'avec une session validée
--     par un code (niveau aal2).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Colonnes
-- ---------------------------------------------------------------------

alter table public.profiles add column if not exists status text not null default 'pending';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_ok') then
    alter table public.profiles add constraint profiles_status_ok check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

-- Les comptes déjà gérés (propriétaire, présidence, vue d'ensemble, membres
-- d'un pôle) sont validés d'office lors de la mise à jour.
update public.profiles p set status = 'approved'
 where status = 'pending'
   and (p.is_owner or p.global_role <> 'none'
        or exists (select 1 from public.memberships m where m.user_id = p.id));

alter table public.poles add column if not exists hidden_from_overview boolean not null default false;
alter table public.poles add column if not exists require_mfa boolean not null default false;
update public.poles set hidden_from_overview = true where id in ('presidence', 'tresorerie');
update public.poles set require_mfa = true where id = 'tresorerie';

-- ---------------------------------------------------------------------
-- Fonctions de base
-- ---------------------------------------------------------------------

-- Session validée par double authentification ?
create or replace function public.session_aal2()
returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function public.user_approved(u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = u and status = 'approved');
$$;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_approved(auth.uid());
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and global_role = 'admin' and status = 'approved');
$$;

-- Admin ou vue d'ensemble (validés)
create or replace function public.sees_all()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and global_role in ('admin', 'overview') and status = 'approved');
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_owner and status = 'approved');
$$;

-- Accès d'un utilisateur donné à un pôle.
-- p_mfa : la session courante est-elle en double authentification ?
create or replace function public.user_can_view_pole(u uuid, p text, p_mfa boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles pr
    where pr.id = u and pr.status = 'approved'
      and (
        pr.global_role = 'admin'
        or (pr.global_role = 'overview'
            and not exists (select 1 from public.poles po where po.id = p and po.hidden_from_overview))
        or exists (
          select 1 from public.memberships m
          join public.poles po on po.id = m.pole_id
          where m.user_id = u and m.pole_id = p
            and (not po.require_mfa or p_mfa))
      )
  );
$$;

create or replace function public.can_view_pole(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_can_view_pole(auth.uid(), p, public.session_aal2());
$$;

create or replace function public.can_edit_pole(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    public.is_approved() and exists (
      select 1 from public.memberships m
      join public.poles po on po.id = m.pole_id
      where m.user_id = auth.uid() and m.pole_id = p and m.role = 'responsable'
        and (not po.require_mfa or public.session_aal2()))
  );
$$;

create or replace function public.is_secretary()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and exists (
    select 1 from public.memberships
    where user_id = auth.uid() and pole_id = 'secretariat' and role = 'responsable');
$$;

-- ---------------------------------------------------------------------
-- Discussions
-- ---------------------------------------------------------------------

create or replace function public.can_see_post(p_audience text[], p_author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and (
    public.is_admin()
    or p_author = auth.uid()
    or cardinality(p_audience) = 0
    or exists (select 1 from unnest(p_audience) as a(id) where public.can_view_pole(a.id))
  );
$$;

create or replace function public.audience_allowed(p_audience text[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and (
    public.is_admin()
    or not exists (select 1 from unnest(p_audience) as a(id) where not public.can_view_pole(a.id))
  );
$$;

-- ---------------------------------------------------------------------
-- Réunions
-- ---------------------------------------------------------------------

create or replace function public.meeting_visible_to_mfa(p_user uuid, p_audience text[], p_bureau_only boolean, p_author uuid, p_mfa boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_approved(p_user) and (
    exists (select 1 from public.profiles where id = p_user and global_role = 'admin')
    or p_author = p_user
    or (p_bureau_only and (
          exists (select 1 from public.profiles where id = p_user and global_role = 'overview')
          or exists (select 1 from public.memberships where user_id = p_user and role = 'responsable')))
    or (not p_bureau_only and (
          cardinality(p_audience) = 0
          or exists (select 1 from unnest(p_audience) as a(id) where public.user_can_view_pole(p_user, a.id, p_mfa))))
  );
$$;

-- Version utilisée par les règles (session courante)
create or replace function public.meeting_visible_to(p_user uuid, p_audience text[], p_bureau_only boolean, p_author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user = auth.uid()
     and public.meeting_visible_to_mfa(p_user, p_audience, p_bureau_only, p_author, public.session_aal2());
$$;

create or replace function public.my_calendar_token()
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text;
begin
  if auth.uid() is null or not public.is_approved() then raise exception 'Compte non validé'; end if;
  insert into public.calendar_tokens (user_id, token) values (auth.uid(), public.new_calendar_token())
    on conflict (user_id) do nothing;
  select token into t from public.calendar_tokens where user_id = auth.uid();
  return t;
end;
$$;

-- Calendrier : pas de session, donc pas de double authentification :
-- les réunions/événements réservés à un pôle 2FA n'y figurent pas.
create or replace function public.calendar_feed(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid;
begin
  if p_token is null or length(p_token) < 40 then
    return jsonb_build_object('valid', false);
  end if;
  select user_id into uid from public.calendar_tokens where token = p_token;
  if uid is null or not public.user_approved(uid) then
    return jsonb_build_object('valid', false);
  end if;
  return jsonb_build_object(
    'valid', true,
    'meetings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
        'location', m.location, 'agenda', m.agenda, 'updated_at', m.updated_at))
      from public.meetings m
      where m.starts_at > now() - interval '60 days'
        and public.meeting_visible_to_mfa(uid, m.audience, m.bureau_only, m.created_by, false)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'event_date', e.event_date, 'description', e.description))
      from public.events e
      where e.event_date is not null
        and e.event_date > current_date - 60
        and exists (select 1 from unnest(e.poles) as a(id) where public.user_can_view_pole(uid, a.id, false))
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Profils : validation par le propriétaire uniquement
-- ---------------------------------------------------------------------

create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  owner_exists boolean;
begin
  if new.id <> old.id then
    raise exception 'Identifiant non modifiable';
  end if;

  if new.is_owner is distinct from old.is_owner and uid is not null then
    raise exception 'Le rôle de propriétaire ne peut être changé que depuis Supabase';
  end if;
  if new.is_owner and (new.global_role <> 'admin' or new.status <> 'approved') then
    raise exception 'Le propriétaire doit rester à la présidence';
  end if;

  if uid is not null then
    select exists (select 1 from public.profiles where is_owner) into owner_exists;

    if old.is_owner and uid <> old.id
       and (new.full_name, new.title, new.global_role, new.status)
           is distinct from (old.full_name, old.title, old.global_role, old.status) then
      raise exception 'Seul le président peut modifier son propre profil';
    end if;

    -- Validation / refus d'un compte
    if new.status is distinct from old.status then
      if owner_exists and not public.is_owner() then
        raise exception 'Seul le président peut valider ou refuser un compte';
      end if;
      if not owner_exists and not public.is_admin() then
        raise exception 'Seule la présidence peut valider un compte';
      end if;
    end if;

    if new.global_role is distinct from old.global_role or new.title is distinct from old.title then
      if not public.is_admin() then
        raise exception 'Seule la présidence peut modifier les rôles';
      end if;
      if new.global_role is distinct from old.global_role
         and (old.global_role = 'admin' or new.global_role = 'admin')
         and owner_exists and not public.is_owner() then
        raise exception 'Seul le président peut nommer ou retirer un membre de la présidence';
      end if;
    end if;
  end if;

  -- Un compte refusé ou remis en attente perd ses rôles et ses pôles
  if new.status <> 'approved' and old.status = 'approved' then
    new.global_role := 'none';
    delete from public.memberships where user_id = new.id;
  end if;

  if old.global_role = 'admin' and new.global_role <> 'admin'
     and not exists (select 1 from public.profiles where global_role = 'admin' and id <> old.id) then
    raise exception 'Il doit rester au moins un administrateur';
  end if;

  new.full_name := trim(new.full_name);
  return new;
end;
$$;

drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (
  id uuid, full_name text, email text, title text, global_role text,
  is_owner boolean, status text, created_at timestamptz, last_sign_in_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé à la présidence';
  end if;
  return query
    select p.id, p.full_name, u.email::text, p.title, p.global_role,
           p.is_owner, p.status, p.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by (p.status = 'pending') desc, p.is_owner desc, p.full_name;
end;
$$;

-- ---------------------------------------------------------------------
-- Règles mises à jour
-- ---------------------------------------------------------------------

drop policy if exists poles_select on public.poles;
create policy poles_select on public.poles for select to authenticated
  using (public.is_approved());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_approved());

drop policy if exists memberships_insert on public.memberships;
create policy memberships_insert on public.memberships for insert to authenticated
  with check (
    public.is_admin()
    or (
      public.is_approved()
      and user_id = auth.uid()
      and role = 'membre'
      and exists (select 1 from public.poles p where p.id = pole_id and p.open_to_members)
    )
  );

drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (public.is_admin() or exists (select 1 from unnest(poles) as p(id) where public.can_view_pole(p.id)));

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------

-- Fonctions internes : appelées seulement par d'autres fonctions de la base
revoke execute on function public.session_aal2()                     from public, anon, authenticated;
revoke execute on function public.user_approved(uuid)                from public, anon, authenticated;
revoke execute on function public.user_can_view_pole(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.meeting_visible_to_mfa(uuid, text[], boolean, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.profiles_guard()                   from public, anon, authenticated;
-- Fonctions utilisées directement par les règles des comptes connectés
revoke execute on function public.is_approved()                      from public, anon;
revoke execute on function public.admin_list_users()                 from public, anon;
grant  execute on function public.is_approved()                      to authenticated;
grant  execute on function public.admin_list_users()                 to authenticated;

-- ---------------------------------------------------------------------
-- Réglages sensibles des pôles réservés au président
-- ---------------------------------------------------------------------

create or replace function public.poles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and (new.hidden_from_overview is distinct from old.hidden_from_overview
          or new.require_mfa is distinct from old.require_mfa)
     and exists (select 1 from public.profiles where is_owner)
     and not public.is_owner() then
    raise exception 'Seul le président peut modifier les réglages de sécurité d''un pôle';
  end if;
  return new;
end;
$$;

drop trigger if exists poles_guard on public.poles;
create trigger poles_guard
  before update on public.poles
  for each row execute function public.poles_guard();

revoke execute on function public.poles_guard() from public, anon, authenticated;

-- Les nouveaux comptes apparaissent en direct chez le président
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
  end if;
end $$;
