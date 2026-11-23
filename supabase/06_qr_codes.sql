-- =====================================================================
--  06 — QR codes dynamiques (jetons, affiches…)
--
--  Le QR code imprimé contient toujours la même adresse :
--      https://<site>/q/            (QR code principal « jetons »)
--      https://<site>/q/?c=<code>   (autres QR codes)
--  Cette page demande à la base où rediriger, compte le scan, puis
--  envoie la personne vers le lien choisi depuis Administration.
--
--  Sécurité :
--   - seule la présidence (admin) voit, crée et modifie les QR codes et
--     leurs statistiques ;
--   - les visiteurs (non connectés) ne peuvent qu'appeler qr_resolve(),
--     qui renvoie le lien et enregistre le scan, rien d'autre.
--  À exécuter une fois dans Supabase (SQL Editor).
-- =====================================================================

create table if not exists public.qr_codes (
  id          text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  label       text not null check (length(label) between 1 and 80),
  target_url  text check (target_url is null or (target_url ~* '^https?://[^\s]+$' and length(target_url) <= 2000)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

create table if not exists public.qr_scans (
  id          bigint generated always as identity primary key,
  qr_id       text not null references public.qr_codes(id) on delete cascade,
  scanned_at  timestamptz not null default now(),
  target_url  text
);
create index if not exists qr_scans_qr_time on public.qr_scans (qr_id, scanned_at);

-- Date et auteur de modification écrits par la base
create or replace function public.qr_codes_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then new.created_at := old.created_at; new.id := old.id; end if;
  return new;
end $$;
drop trigger if exists qr_codes_stamp on public.qr_codes;
create trigger qr_codes_stamp before insert or update on public.qr_codes
  for each row execute function public.qr_codes_stamp();
revoke execute on function public.qr_codes_stamp() from public, anon, authenticated;

alter table public.qr_codes enable row level security;
alter table public.qr_scans enable row level security;

drop policy if exists qr_codes_admin_select on public.qr_codes;
drop policy if exists qr_codes_admin_insert on public.qr_codes;
drop policy if exists qr_codes_admin_update on public.qr_codes;
drop policy if exists qr_codes_admin_delete on public.qr_codes;
create policy qr_codes_admin_select on public.qr_codes for select to authenticated using (public.is_admin());
create policy qr_codes_admin_insert on public.qr_codes for insert to authenticated with check (public.is_admin());
create policy qr_codes_admin_update on public.qr_codes for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy qr_codes_admin_delete on public.qr_codes for delete to authenticated using (public.is_admin() and id <> 'jetons');

drop policy if exists qr_scans_admin_select on public.qr_scans;
drop policy if exists qr_scans_admin_delete on public.qr_scans;
create policy qr_scans_admin_select on public.qr_scans for select to authenticated using (public.is_admin());
create policy qr_scans_admin_delete on public.qr_scans for delete to authenticated using (public.is_admin());
-- Aucune règle d'insertion : les scans ne s'écrivent que via qr_resolve().

revoke all on public.qr_codes from anon;
revoke all on public.qr_scans from anon;

-- Appelée par la page /q/ : renvoie le lien et compte le scan
create or replace function public.qr_resolve(p_id text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_url text;
begin
  select target_url into v_url from public.qr_codes where id = lower(coalesce(p_id, ''));
  if not found then return null; end if;
  insert into public.qr_scans (qr_id, target_url) values (lower(p_id), v_url);
  return v_url;
end $$;
revoke execute on function public.qr_resolve(text) from public;
grant  execute on function public.qr_resolve(text) to anon, authenticated;

-- Statistiques (présidence uniquement), jours à l'heure de Paris
create or replace function public.qr_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'permission denied'; end if;
  return coalesce((
    select jsonb_object_agg(c.id, jsonb_build_object(
      'total', (select count(*) from public.qr_scans s where s.qr_id = c.id),
      'today', (select count(*) from public.qr_scans s where s.qr_id = c.id
                  and (s.scanned_at at time zone 'Europe/Paris')::date = (now() at time zone 'Europe/Paris')::date),
      'week',  (select count(*) from public.qr_scans s where s.qr_id = c.id and s.scanned_at > now() - interval '7 days'),
      'last',  (select max(s.scanned_at) from public.qr_scans s where s.qr_id = c.id),
      'days',  (select coalesce(jsonb_agg(jsonb_build_object('d', d.day, 'n', d.n) order by d.day), '[]'::jsonb)
                  from (select (s.scanned_at at time zone 'Europe/Paris')::date as day, count(*) as n
                          from public.qr_scans s
                         where s.qr_id = c.id and s.scanned_at > now() - interval '30 days'
                         group by 1) d)))
    from public.qr_codes c), '{}'::jsonb);
end $$;
revoke execute on function public.qr_stats() from public, anon;
grant  execute on function public.qr_stats() to authenticated;

-- QR code principal (celui des jetons), à activer depuis Administration
insert into public.qr_codes (id, label, target_url) values ('jetons', 'QR code des jetons', null)
on conflict (id) do nothing;
