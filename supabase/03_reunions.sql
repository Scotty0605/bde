-- =====================================================================
--  BDE — Réunions, comptes rendus et calendrier
--  (déjà inclus à la fin de schema.sql ; ce fichier sert à mettre à jour
--   une base existante. Peut être relancé sans risque.)
--
--  Qui gère les réunions :
--   - Présidence et responsables du pôle Secrétariat : toutes les réunions
--   - Un responsable de pôle : les réunions de son/ses pôle(s)
--   - L'auteur d'une réunion peut la modifier et y déposer le compte rendu
-- =====================================================================

create table if not exists public.meetings (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(trim(title)) between 1 and 150),
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  location     text check (location is null or length(location) <= 200),
  agenda       text check (agenda is null or length(agenda) <= 8000),      -- ordre du jour
  audience     text[] not null default '{}',     -- pôles invités ; vide = tout le monde
  bureau_only  boolean not null default false,   -- réservé au bureau (présidence, secrétariat, responsables)
  minutes      text check (minutes is null or length(minutes) <= 100000), -- compte rendu (texte)
  minutes_by   uuid references public.profiles (id) on delete set null,
  minutes_at   timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint meetings_dates_ok check (ends_at is null or ends_at > starts_at)
);

create index if not exists meetings_starts_idx on public.meetings (starts_at);

-- Fichiers de compte rendu (Word, PDF...) stockés dans le bucket "comptes-rendus"
create table if not exists public.meeting_files (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings (id) on delete cascade,
  name         text not null check (length(name) between 1 and 255),
  path         text not null unique,
  size         bigint,
  mime         text,
  uploaded_by  uuid references public.profiles (id) on delete set null,
  uploaded_at  timestamptz not null default now()
);

create index if not exists meeting_files_meeting_idx on public.meeting_files (meeting_id);

-- Lien personnel d'abonnement au calendrier (secret, réinitialisable)
create table if not exists public.calendar_tokens (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------

create or replace function public.is_secretary()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships
                 where user_id = auth.uid() and pole_id = 'secretariat' and role = 'responsable');
$$;

-- Visibilité d'une réunion pour un utilisateur donné (sert aussi au calendrier)
create or replace function public.meeting_visible_to(p_user uuid, p_audience text[], p_bureau_only boolean, p_author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and (
    exists (select 1 from public.profiles where id = p_user and global_role in ('admin', 'overview'))
    or p_author = p_user
    or (p_bureau_only and exists (select 1 from public.memberships where user_id = p_user and role = 'responsable'))
    or (not p_bureau_only and (
          cardinality(p_audience) = 0
          or exists (select 1 from public.memberships m where m.user_id = p_user and m.pole_id = any (p_audience))))
  );
$$;

create or replace function public.can_see_meeting(p_meeting uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.meeting_visible_to(auth.uid(), audience, bureau_only, created_by)
                   from public.meetings where id = p_meeting), false);
$$;

create or replace function public.can_manage_meeting(p_meeting uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.is_admin() or public.is_secretary() or created_by = auth.uid()
                   from public.meetings where id = p_meeting), false);
$$;

create or replace function public.can_create_meeting(p_audience text[], p_bureau_only boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.is_secretary() or (
    not p_bureau_only
    and cardinality(p_audience) > 0
    and not exists (select 1 from unnest(p_audience) as a(id) where not public.can_edit_pole(a.id))
  );
$$;

create or replace function public.safe_uuid(t text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

create or replace function public.meetings_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.bureau_only then
    new.audience := '{}';
  end if;
  new.minutes := nullif(trim(coalesce(new.minutes, '')), '');
  if tg_op = 'INSERT' or new.minutes is distinct from old.minutes then
    if new.minutes is null then
      new.minutes_by := null; new.minutes_at := null;
    else
      new.minutes_by := auth.uid(); new.minutes_at := now();
    end if;
  else
    new.minutes_by := old.minutes_by; new.minutes_at := old.minutes_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meetings_before_write on public.meetings;
create trigger meetings_before_write
  before insert or update on public.meetings
  for each row execute function public.meetings_before_write();

create or replace function public.meeting_files_before_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  new.uploaded_by := auth.uid();
  new.uploaded_at := now();
  return new;
end;
$$;

drop trigger if exists meeting_files_before_insert on public.meeting_files;
create trigger meeting_files_before_insert
  before insert on public.meeting_files
  for each row execute function public.meeting_files_before_insert();

-- ---------------------------------------------------------------------
-- Règles de sécurité
-- ---------------------------------------------------------------------

alter table public.meetings        enable row level security;
alter table public.meeting_files   enable row level security;
alter table public.calendar_tokens enable row level security;

do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('meetings', 'meeting_files', 'calendar_tokens')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy meetings_select on public.meetings for select to authenticated
  using (public.meeting_visible_to(auth.uid(), audience, bureau_only, created_by));
create policy meetings_insert on public.meetings for insert to authenticated
  with check (public.can_create_meeting(audience, bureau_only));
create policy meetings_update on public.meetings for update to authenticated
  using (public.is_admin() or public.is_secretary() or created_by = auth.uid())
  with check (public.is_admin() or public.is_secretary()
              or (created_by = auth.uid() and public.can_create_meeting(audience, bureau_only)));
create policy meetings_delete on public.meetings for delete to authenticated
  using (public.is_admin() or public.is_secretary() or created_by = auth.uid());

create policy meeting_files_select on public.meeting_files for select to authenticated
  using (public.can_see_meeting(meeting_id));
create policy meeting_files_insert on public.meeting_files for insert to authenticated
  with check (public.can_manage_meeting(meeting_id) and path like meeting_id::text || '/%');
create policy meeting_files_delete on public.meeting_files for delete to authenticated
  using (public.can_manage_meeting(meeting_id));

create policy calendar_tokens_select on public.calendar_tokens for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Calendrier
-- ---------------------------------------------------------------------

create or replace function public.new_calendar_token()
returns text language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Renvoie (et crée si besoin) le lien personnel de l'utilisateur connecté
create or replace function public.my_calendar_token()
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  insert into public.calendar_tokens (user_id, token) values (auth.uid(), public.new_calendar_token())
    on conflict (user_id) do nothing;
  select token into t from public.calendar_tokens where user_id = auth.uid();
  return t;
end;
$$;

-- Nouveau lien (l'ancien cesse de fonctionner)
create or replace function public.reset_calendar_token()
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text := public.new_calendar_token();
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  insert into public.calendar_tokens (user_id, token) values (auth.uid(), t)
    on conflict (user_id) do update set token = excluded.token, created_at = now();
  return t;
end;
$$;

-- Contenu du calendrier pour un lien donné : réunions (60 derniers jours et à venir)
-- et événements visibles par la personne. Appelé par le programme "calendar".
create or replace function public.calendar_feed(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid;
  sees boolean;
begin
  if p_token is null or length(p_token) < 40 then
    return jsonb_build_object('valid', false);
  end if;
  select user_id into uid from public.calendar_tokens where token = p_token;
  if uid is null then
    return jsonb_build_object('valid', false);
  end if;
  select global_role in ('admin', 'overview') into sees from public.profiles where id = uid;

  return jsonb_build_object(
    'valid', true,
    'meetings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
        'location', m.location, 'agenda', m.agenda, 'updated_at', m.updated_at))
      from public.meetings m
      where m.starts_at > now() - interval '60 days'
        and public.meeting_visible_to(uid, m.audience, m.bureau_only, m.created_by)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'event_date', e.event_date, 'description', e.description))
      from public.events e
      where e.event_date is not null
        and e.event_date > current_date - 60
        and (coalesce(sees, false)
             or exists (select 1 from public.memberships mm where mm.user_id = uid and mm.pole_id = any (e.poles)))
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Stockage des fichiers de compte rendu (bucket privé, 20 Mo max)
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('comptes-rendus', 'comptes-rendus', false, 20971520)
    on conflict (id) do nothing;

    execute 'drop policy if exists cr_select on storage.objects';
    execute 'drop policy if exists cr_insert on storage.objects';
    execute 'drop policy if exists cr_delete on storage.objects';
    execute $p$create policy cr_select on storage.objects for select to authenticated
      using (bucket_id = 'comptes-rendus' and public.can_see_meeting(public.safe_uuid((storage.foldername(name))[1])))$p$;
    execute $p$create policy cr_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'comptes-rendus' and public.can_manage_meeting(public.safe_uuid((storage.foldername(name))[1])))$p$;
    execute $p$create policy cr_delete on storage.objects for delete to authenticated
      using (bucket_id = 'comptes-rendus' and public.can_manage_meeting(public.safe_uuid((storage.foldername(name))[1])))$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------

revoke execute on function public.meetings_before_write()       from public, anon, authenticated;
revoke execute on function public.meeting_files_before_insert() from public, anon, authenticated;
revoke execute on function public.new_calendar_token()          from public, anon, authenticated;
revoke execute on function public.is_secretary()                                  from public, anon;
revoke execute on function public.meeting_visible_to(uuid, text[], boolean, uuid) from public, anon;
revoke execute on function public.can_see_meeting(uuid)                           from public, anon;
revoke execute on function public.can_manage_meeting(uuid)                        from public, anon;
revoke execute on function public.can_create_meeting(text[], boolean)             from public, anon;
revoke execute on function public.my_calendar_token()                             from public, anon;
revoke execute on function public.reset_calendar_token()                          from public, anon;
revoke execute on function public.calendar_feed(text)                             from public;
grant  execute on function public.is_secretary()                      to authenticated;
grant  execute on function public.meeting_visible_to(uuid, text[], boolean, uuid) to authenticated;
grant  execute on function public.can_see_meeting(uuid)               to authenticated;
grant  execute on function public.can_manage_meeting(uuid)            to authenticated;
grant  execute on function public.can_create_meeting(text[], boolean) to authenticated;
grant  execute on function public.my_calendar_token()                 to authenticated;
grant  execute on function public.reset_calendar_token()              to authenticated;
-- Le calendrier est lu sans connexion (par l'appli agenda) : protégé par le lien secret
grant  execute on function public.calendar_feed(text)                 to anon, authenticated;

-- ---------------------------------------------------------------------
-- Temps réel
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.meetings;      exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.meeting_files; exception when duplicate_object then null; end;
  end if;
end $$;
