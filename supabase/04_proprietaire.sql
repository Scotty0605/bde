-- =====================================================================
--  BDE — Rôle de propriétaire (le président)
--  (déjà inclus à la fin de schema.sql ; ce fichier sert à mettre à jour
--   une base existante. Peut être relancé sans risque.)
--
--  - Un seul propriétaire ; il fait toujours partie de la présidence.
--  - Seul le propriétaire peut nommer ou retirer un membre de la présidence.
--  - Personne d'autre ne peut modifier le profil du propriétaire.
--  - Le titre de propriétaire ne se change que depuis Supabase (SQL Editor).
--  - Tant qu'aucun propriétaire n'est désigné, la présidence garde les
--    anciens droits (n'importe quel admin gère les rôles).
-- =====================================================================

alter table public.profiles add column if not exists is_owner boolean not null default false;
create unique index if not exists profiles_one_owner on public.profiles (is_owner) where is_owner;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_owner);
$$;

create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  owner_exists boolean;
begin
  if new.id <> old.id then
    raise exception 'Identifiant non modifiable';
  end if;

  -- Le titre de propriétaire ne se change que depuis Supabase
  if new.is_owner is distinct from old.is_owner and uid is not null then
    raise exception 'Le rôle de propriétaire ne peut être changé que depuis Supabase';
  end if;
  if new.is_owner and new.global_role <> 'admin' then
    raise exception 'Le propriétaire doit rester à la présidence';
  end if;

  if uid is not null then
    -- Profil du propriétaire : intouchable par les autres
    if old.is_owner and uid <> old.id
       and (new.full_name, new.title, new.global_role) is distinct from (old.full_name, old.title, old.global_role) then
      raise exception 'Seul le président peut modifier son propre profil';
    end if;

    if new.global_role is distinct from old.global_role or new.title is distinct from old.title then
      if not public.is_admin() then
        raise exception 'Seule la présidence peut modifier les rôles';
      end if;
      select exists (select 1 from public.profiles where is_owner) into owner_exists;
      if new.global_role is distinct from old.global_role
         and (old.global_role = 'admin' or new.global_role = 'admin')
         and owner_exists and not public.is_owner() then
        raise exception 'Seul le président peut nommer ou retirer un membre de la présidence';
      end if;
    end if;
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
  is_owner boolean, created_at timestamptz, last_sign_in_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé à la présidence';
  end if;
  return query
    select p.id, p.full_name, u.email::text, p.title, p.global_role,
           p.is_owner, p.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.is_owner desc, p.full_name;
end;
$$;

revoke execute on function public.admin_list_users() from public, anon;
grant  execute on function public.admin_list_users() to authenticated;
revoke execute on function public.profiles_guard()   from public, anon, authenticated;
revoke execute on function public.is_owner()         from public, anon;
grant  execute on function public.is_owner()         to authenticated;

-- =====================================================================
--  Désigner le propriétaire (une seule fois, depuis le SQL Editor) :
--
--  update public.profiles set is_owner = true, global_role = 'admin'
--   where id = (select id from auth.users where email = 'ton.email@exemple.fr');
-- =====================================================================
