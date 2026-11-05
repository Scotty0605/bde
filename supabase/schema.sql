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



-- Publications : questions et sondages
create table if not exists public.posts (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('question', 'sondage')),
  title           text not null check (length(trim(title)) between 1 and 200),
  body            text check (body is null or length(body) <= 4000),
  -- Pôles qui voient la publication ; vide = tout le bureau
  audience        text[] not null default '{}',
  -- true : réponses et résultats visibles par tous ceux qui voient la publication
  -- false : visibles seulement par l'auteur et la présidence
  replies_public  boolean not null default true,
  options         text[] not null default '{}',
  allow_multiple  boolean not null default false,
  closed          boolean not null default false,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint posts_options_ok check (
    (kind = 'question' and cardinality(options) = 0)
    or (kind = 'sondage' and cardinality(options) between 2 and 10)
  )
);

create table if not exists public.post_replies (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts (id) on delete cascade,
  body        text not null check (length(trim(body)) between 1 and 4000),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.post_votes (
  post_id     uuid not null references public.posts (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  option_idx  int  not null check (option_idx >= 0),
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id, option_idx)
);

create index if not exists post_replies_post_idx on public.post_replies (post_id);
create index if not exists post_votes_post_idx   on public.post_votes (post_id);
create index if not exists posts_created_idx     on public.posts (created_at desc);

-- ---------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------

-- Voir une publication : présidence / vue d'ensemble, l'auteur, ou
-- quelqu'un qui a accès à un des pôles visés (ou à tous si public).
create or replace function public.can_see_post(p_audience text[], p_author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.sees_all()
    or p_author = auth.uid()
    or cardinality(p_audience) = 0
    or exists (select 1 from unnest(p_audience) as a(id) where public.can_view_pole(a.id))
  );
$$;

create or replace function public.can_see_post_id(p_post uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.can_see_post(audience, created_by) from public.posts where id = p_post), false);
$$;

-- Voir les réponses / résultats d'une publication
create or replace function public.can_see_answers(p_post uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select public.can_see_post(audience, created_by)
           and (replies_public or created_by = auth.uid() or public.is_admin())
    from public.posts where id = p_post
  ), false);
$$;

-- On ne peut viser que des pôles auxquels on a accès
create or replace function public.audience_allowed(p_audience text[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.sees_all()
      or not exists (select 1 from unnest(p_audience) as a(id) where not public.can_view_pole(a.id));
$$;

-- ---------------------------------------------------------------------
-- Triggers : auteur et date toujours fixés par la base
-- ---------------------------------------------------------------------

create or replace function public.posts_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.title := trim(new.title);
  else
    -- Type, choix et auteur ne changent pas après publication
    new.id := old.id;
    new.kind := old.kind;
    new.options := old.options;
    new.allow_multiple := old.allow_multiple;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_before_write on public.posts;
create trigger posts_before_write
  before insert or update on public.posts
  for each row execute function public.posts_before_write();

create or replace function public.replies_before_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  new.created_by := auth.uid();
  new.created_at := now();
  new.body := trim(new.body);
  return new;
end;
$$;

drop trigger if exists replies_before_insert on public.post_replies;
create trigger replies_before_insert
  before insert on public.post_replies
  for each row execute function public.replies_before_insert();

-- ---------------------------------------------------------------------
-- Vote : passe uniquement par cette fonction (remplace le vote précédent)
-- ---------------------------------------------------------------------

create or replace function public.vote(p_post uuid, p_options int[])
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.posts;
begin
  if auth.uid() is null then
    raise exception 'Connexion requise';
  end if;
  select * into p from public.posts where id = p_post;
  if not found or not public.can_see_post(p.audience, p.created_by) then
    raise exception 'Sondage introuvable';
  end if;
  if p.kind <> 'sondage' then
    raise exception 'Ce n''est pas un sondage';
  end if;
  if p.closed then
    raise exception 'Ce sondage est clos';
  end if;
  p_options := coalesce(p_options, '{}');
  if not p.allow_multiple and cardinality(p_options) > 1 then
    raise exception 'Un seul choix possible';
  end if;
  if exists (select 1 from unnest(p_options) as o(i) where o.i < 0 or o.i >= cardinality(p.options)) then
    raise exception 'Choix invalide';
  end if;

  delete from public.post_votes where post_id = p_post and user_id = auth.uid();
  insert into public.post_votes (post_id, user_id, option_idx)
    select distinct p_post, auth.uid(), o.i from unnest(p_options) as o(i);
end;
$$;

-- ---------------------------------------------------------------------
-- Règles de sécurité
-- ---------------------------------------------------------------------

alter table public.posts        enable row level security;
alter table public.post_replies enable row level security;
alter table public.post_votes   enable row level security;

do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('posts', 'post_replies', 'post_votes')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy posts_select on public.posts for select to authenticated
  using (public.can_see_post(audience, created_by));
create policy posts_insert on public.posts for insert to authenticated
  with check (public.audience_allowed(audience));
create policy posts_update on public.posts for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (public.is_admin() or (created_by = auth.uid() and public.audience_allowed(audience)));
create policy posts_delete on public.posts for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

create policy replies_select on public.post_replies for select to authenticated
  using (created_by = auth.uid() or public.can_see_answers(post_id));
create policy replies_insert on public.post_replies for insert to authenticated
  with check (
    public.can_see_post_id(post_id)
    and not exists (select 1 from public.posts p where p.id = post_id and p.closed)
  );
create policy replies_delete on public.post_replies for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- Aucune écriture directe sur les votes : tout passe par vote()
create policy votes_select on public.post_votes for select to authenticated
  using (user_id = auth.uid() or public.can_see_answers(post_id));

-- ---------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------

revoke execute on function public.posts_before_write()     from public, anon, authenticated;
revoke execute on function public.replies_before_insert()  from public, anon, authenticated;
revoke execute on function public.can_see_post(text[], uuid) from public, anon;
revoke execute on function public.can_see_post_id(uuid)      from public, anon;
revoke execute on function public.can_see_answers(uuid)      from public, anon;
revoke execute on function public.audience_allowed(text[])   from public, anon;
revoke execute on function public.vote(uuid, int[])          from public, anon;
grant  execute on function public.can_see_post(text[], uuid) to authenticated;
grant  execute on function public.can_see_post_id(uuid)      to authenticated;
grant  execute on function public.can_see_answers(uuid)      to authenticated;
grant  execute on function public.audience_allowed(text[])   to authenticated;
grant  execute on function public.vote(uuid, int[])          to authenticated;

-- ---------------------------------------------------------------------
-- Temps réel
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.posts;        exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.post_replies; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.post_votes;   exception when duplicate_object then null; end;
  end if;
end $$;


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
