-- =====================================================================
--  BDE — Discussions & sondages
--  (déjà inclus à la fin de schema.sql ; ce fichier sert à mettre à jour
--   une base existante. Peut être relancé sans risque.)
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
