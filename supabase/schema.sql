-- =====================================================================
--  BDE — Organisation des pôles
--  Schéma Supabase : tables, règles de sécurité (RLS), historique.
--
--  À coller en entier dans Supabase > SQL Editor > New query > Run.
--  Le script peut être relancé : il ne recrée que ce qui manque
--  (sauf la partie "pôles par défaut", qui n'ajoute que les pôles absents).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- Les pôles du BDE (Présidence, Trésorerie, Communication...)
create table if not exists public.poles (
  id               text primary key check (id ~ '^[a-z0-9_-]+$'),
  name             text not null check (length(trim(name)) between 1 and 60),
  color            text not null default '#5b5bd6',
  sort             int  not null default 100,
  -- Un membre (non-responsable) peut-il s'inscrire seul dans ce pôle,
  -- en lecture seule ? Toujours "false" pour Présidence et Trésorerie.
  open_to_members  boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Profil de chaque compte (créé automatiquement à l'inscription)
--   global_role :
--     'admin'    -> Président / Vice-président : voit et modifie tout
--     'overview' -> Secrétaire général : voit tout, en lecture seule
--     'none'     -> accès uniquement aux pôles attribués
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  full_name    text not null default '',
  title        text,                         -- ex. "Président", "Responsable com"
  global_role  text not null default 'none'
               check (global_role in ('admin', 'overview', 'none')),
  created_at   timestamptz not null default now()
);

-- Qui a accès à quel pôle, et avec quel rôle
--   'responsable' -> crée, modifie et coche les tâches du pôle
--   'membre'      -> lecture seule
create table if not exists public.memberships (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  pole_id     text not null references public.poles (id) on delete cascade,
  role        text not null check (role in ('responsable', 'membre')),
  created_at  timestamptz not null default now(),
  primary key (user_id, pole_id)
);

-- Événements qui peuvent concerner plusieurs pôles (gala, soirée, WEI...)
create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(trim(title)) between 1 and 120),
  description  text,
  event_date   date,
  poles        text[] not null default '{}',  -- pôles concernés
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

-- Les tâches
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  pole_id      text not null references public.poles (id) on delete cascade,
  event_id     uuid references public.events (id) on delete set null,
  title        text not null check (length(trim(title)) between 1 and 200),
  description  text,
  due_date     date,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  done         boolean not null default false,
  -- Remplis par la base elle-même (impossible à falsifier depuis le site)
  done_by      uuid references public.profiles (id) on delete set null,
  done_at      timestamptz
);

create index if not exists tasks_pole_idx  on public.tasks (pole_id);
create index if not exists tasks_event_idx on public.tasks (event_id);
create index if not exists tasks_due_idx   on public.tasks (due_date);

-- Historique : qui a créé / coché / décoché / modifié / supprimé, et quand.
-- Rempli uniquement par la base ; personne ne peut l'éditer depuis le site.
create table if not exists public.task_log (
  id          bigint generated always as identity primary key,
  task_id     uuid not null,
  pole_id     text not null,
  task_title  text not null,
  action      text not null,   -- creation | cochee | decochee | modification | suppression
  user_id     uuid references public.profiles (id) on delete set null,
  at          timestamptz not null default now()
);

create index if not exists task_log_task_idx on public.task_log (task_id);
create index if not exists task_log_at_idx   on public.task_log (at desc);


-- ---------------------------------------------------------------------
-- 2. FONCTIONS DE DROITS (utilisées par les règles de sécurité)
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and global_role = 'admin'
  );
$$;

-- Admin ou Secrétaire général (vue d'ensemble)
create or replace function public.sees_all()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and global_role in ('admin', 'overview')
  );
$$;

create or replace function public.can_view_pole(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.sees_all() or exists (
    select 1 from public.memberships
    where user_id = auth.uid() and pole_id = p
  );
$$;

create or replace function public.can_edit_pole(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.memberships
    where user_id = auth.uid() and pole_id = p and role = 'responsable'
  );
$$;


-- ---------------------------------------------------------------------
-- 3. TRIGGERS
-- ---------------------------------------------------------------------

-- 3a. Création automatique du profil à l'inscription
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
             split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3b. Seul un admin peut changer un rôle global ou un titre.
--     (Depuis l'éditeur SQL de Supabase, auth.uid() est vide : autorisé,
--      c'est comme ça que tu te nommes admin la première fois.)
--     Garde-fou : impossible de retirer le dernier admin.
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.id <> old.id then
    raise exception 'Identifiant non modifiable';
  end if;

  if (new.global_role is distinct from old.global_role
      or new.title is distinct from old.title)
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Seule la présidence peut modifier les rôles';
  end if;

  if old.global_role = 'admin' and new.global_role <> 'admin'
     and not exists (select 1 from public.profiles
                     where global_role = 'admin' and id <> old.id) then
    raise exception 'Il doit rester au moins un administrateur';
  end if;

  new.full_name := trim(new.full_name);
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- 3c. "Coché par / coché le" : toujours rempli par la base avec
--     le compte réellement connecté et l'heure du serveur.
create or replace function public.tasks_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    if new.done then
      new.done_by := auth.uid();
      new.done_at := now();
    else
      new.done_by := null;
      new.done_at := null;
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.done is distinct from old.done then
      if new.done then
        new.done_by := auth.uid();
        new.done_at := now();
      else
        new.done_by := null;
        new.done_at := null;
      end if;
    else
      new.done_by := old.done_by;
      new.done_at := old.done_at;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_before_write on public.tasks;
create trigger tasks_before_write
  before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- 3d. Écriture automatique de l'historique
create or replace function public.tasks_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  act text;
begin
  if tg_op = 'INSERT' then
    insert into public.task_log (task_id, pole_id, task_title, action, user_id)
    values (new.id, new.pole_id, new.title, 'creation', auth.uid());
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.task_log (task_id, pole_id, task_title, action, user_id)
    values (old.id, old.pole_id, old.title, 'suppression', auth.uid());
    return old;
  else
    if new.done is distinct from old.done then
      act := case when new.done then 'cochee' else 'decochee' end;
    elsif (new.title, new.description, new.due_date, new.pole_id, new.event_id)
          is distinct from
          (old.title, old.description, old.due_date, old.pole_id, old.event_id) then
      act := 'modification';
    else
      return new;
    end if;
    insert into public.task_log (task_id, pole_id, task_title, action, user_id)
    values (new.id, new.pole_id, new.title, act, auth.uid());
    return new;
  end if;
end;
$$;

drop trigger if exists tasks_log on public.tasks;
create trigger tasks_log
  after insert or update or delete on public.tasks
  for each row execute function public.tasks_log();

-- 3e. created_by des événements
create or replace function public.events_before_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists events_before_insert on public.events;
create trigger events_before_insert
  before insert on public.events
  for each row execute function public.events_before_insert();


-- ---------------------------------------------------------------------
-- 4. RÈGLES DE SÉCURITÉ (Row Level Security)
--    Appliquées par la base de données : même en contournant le site,
--    personne ne lit ni ne modifie ce à quoi il n'a pas droit.
-- ---------------------------------------------------------------------

alter table public.poles       enable row level security;
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;
alter table public.events      enable row level security;
alter table public.tasks       enable row level security;
alter table public.task_log    enable row level security;

-- On repart de zéro pour pouvoir relancer le script
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('poles','profiles','memberships','events','tasks','task_log')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- POLES : tout compte connecté voit la liste ; seuls les admins la gèrent
create policy poles_select on public.poles for select to authenticated using (true);
create policy poles_insert on public.poles for insert to authenticated with check (public.is_admin());
create policy poles_update on public.poles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy poles_delete on public.poles for delete to authenticated using (public.is_admin());

-- PROFILES : les noms sont visibles par les comptes connectés (pour
-- afficher "coché par X"). Chacun modifie son nom ; les rôles sont
-- protégés par le trigger profiles_guard.
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- MEMBERSHIPS
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.can_view_pole(pole_id));
-- Un admin attribue tout. Un compte peut s'ajouter lui-même uniquement
-- comme 'membre' (lecture seule) dans un pôle ouvert aux membres.
create policy memberships_insert on public.memberships for insert to authenticated
  with check (
    public.is_admin()
    or (
      user_id = auth.uid()
      and role = 'membre'
      and exists (select 1 from public.poles p where p.id = pole_id and p.open_to_members)
    )
  );
create policy memberships_update on public.memberships for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- Un admin retire n'importe qui ; un membre peut quitter un pôle où il est 'membre'
create policy memberships_delete on public.memberships for delete to authenticated
  using (public.is_admin() or (user_id = auth.uid() and role = 'membre'));

-- EVENTS : visibles si l'on voit au moins un des pôles concernés
create policy events_select on public.events for select to authenticated
  using (
    public.sees_all()
    or exists (select 1 from unnest(poles) as p(id) where public.can_view_pole(p.id))
  );
create policy events_insert on public.events for insert to authenticated with check (public.is_admin());
create policy events_update on public.events for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy events_delete on public.events for delete to authenticated using (public.is_admin());

-- TASKS : lecture si accès au pôle ; écriture (créer, modifier, cocher,
-- supprimer) uniquement pour le responsable du pôle ou un admin.
create policy tasks_select on public.tasks for select to authenticated
  using (public.can_view_pole(pole_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.can_edit_pole(pole_id));
create policy tasks_update on public.tasks for update to authenticated
  using (public.can_edit_pole(pole_id))
  with check (public.can_edit_pole(pole_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.can_edit_pole(pole_id));

-- TASK_LOG : lecture seule, si accès au pôle. Aucune écriture possible
-- depuis le site (seuls les triggers écrivent).
create policy task_log_select on public.task_log for select to authenticated
  using (public.can_view_pole(pole_id));


-- ---------------------------------------------------------------------
-- 5. LISTE DES COMPTES POUR L'ADMINISTRATION (avec e-mail)
--    Les e-mails ne sont visibles que par les admins.
-- ---------------------------------------------------------------------

create or replace function public.admin_list_users()
returns table (
  id uuid, full_name text, email text, title text,
  global_role text, created_at timestamptz, last_sign_in_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Réservé à la présidence';
  end if;
  return query
    select p.id, p.full_name, u.email::text, p.title, p.global_role,
           p.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.full_name;
end;
$$;

revoke execute on function public.admin_list_users() from public, anon;
grant  execute on function public.admin_list_users() to authenticated;

-- Fonctions de triggers : personne n'a besoin de les appeler directement
revoke execute on function public.handle_new_user()      from public, anon, authenticated;
revoke execute on function public.profiles_guard()       from public, anon, authenticated;
revoke execute on function public.tasks_log()            from public, anon, authenticated;
revoke execute on function public.tasks_before_write()   from public, anon, authenticated;
revoke execute on function public.events_before_insert() from public, anon, authenticated;

-- Fonctions de droits : réservées aux comptes connectés (règles RLS)
revoke execute on function public.is_admin()           from public, anon;
revoke execute on function public.sees_all()           from public, anon;
revoke execute on function public.can_view_pole(text)  from public, anon;
revoke execute on function public.can_edit_pole(text)  from public, anon;
grant  execute on function public.is_admin()           to authenticated;
grant  execute on function public.sees_all()           to authenticated;
grant  execute on function public.can_view_pole(text)  to authenticated;
grant  execute on function public.can_edit_pole(text)  to authenticated;


-- ---------------------------------------------------------------------
-- 6. TEMPS RÉEL (le site se met à jour tout seul quand quelqu'un coche)
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.tasks;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.events;
    exception when duplicate_object then null;
    end;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 7. PÔLES PAR DÉFAUT (modifiables ensuite depuis le site)
-- ---------------------------------------------------------------------

insert into public.poles (id, name, color, sort, open_to_members) values
  ('presidence',                'Présidence',                '#5b5bd6', 10, false),
  ('secretariat',               'Secrétariat',               '#0e9f8e', 20, true),
  ('tresorerie',                'Trésorerie',                '#d97706', 30, false),
  ('communication',             'Communication',             '#db2777', 40, true),
  ('logistique',                'Logistique',                '#65a30d', 50, true),
  ('sponsors',                  'Sponsors',                  '#2563eb', 60, true),
  ('animation',                 'Animation',                 '#7c3aed', 70, true),
  ('prepa',                     'Prépa',                     '#0891b2', 80, true),
  ('relations-internationales', 'Relations internationales', '#e11d48', 90, true)
on conflict (id) do nothing;


-- =====================================================================
--  APRÈS TA PREMIÈRE INSCRIPTION SUR LE SITE, nomme-toi administrateur
--  en lançant ceci (remplace l'e-mail) :
--
--  update public.profiles
--     set global_role = 'admin', title = 'Président'
--   where id = (select id from auth.users where email = 'ton.email@exemple.fr');
-- =====================================================================
