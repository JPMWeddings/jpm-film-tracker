-- JPM Film Tracker: database setup.
-- Paste this whole file into Supabase > SQL Editor > New query > Run. Safe to run more than once.

create table if not exists public.couples (
  id              uuid primary key default gen_random_uuid(),
  notion_id       text unique not null,          -- Weddings row in Notion
  emails          text[] not null default '{}',  -- lowercase; who may sign in
  names           text not null,                 -- "Ava & Marcus"
  collection      text,                          -- The Feature / The Short Film
  wedding_date    date,
  venue           text,
  stage_index     int not null default -1,       -- -1 before wedding, 0..6 client stages
  stage_dates     jsonb not null default '[]',   -- 7 dates (or null), one per stage
  deliverables    jsonb not null default '[]',   -- [{name, desc, status, date, link}]
  film_link       text,                          -- VidFlow, only once delivered
  raw_link        text,                          -- raw footage, only once delivered
  delivery_window text,                          -- only when Show Delivery Window is on
  last_update     date,
  synced_at       timestamptz not null default now()
);

alter table public.couples enable row level security;

-- A signed-in couple can read ONLY their own row. Nobody can write from the website.
drop policy if exists "couple reads own film" on public.couples;
create policy "couple reads own film" on public.couples
  for select to authenticated
  using (lower(auth.jwt() ->> 'email') = any (emails));

-- Private bucket for couple cover photos: covers/<couple id>/cover.jpg
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "couple reads own cover" on storage.objects;
create policy "couple reads own cover" on storage.objects
  for select to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] in
         (select id::text from public.couples where lower(auth.jwt() ->> 'email') = any (emails)));

drop policy if exists "couple adds own cover" on storage.objects;
create policy "couple adds own cover" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] in
         (select id::text from public.couples where lower(auth.jwt() ->> 'email') = any (emails)));

drop policy if exists "couple replaces own cover" on storage.objects;
create policy "couple replaces own cover" on storage.objects
  for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] in
         (select id::text from public.couples where lower(auth.jwt() ->> 'email') = any (emails)));

-- Status update emails: queued when a film moves forward, sent about 10 minutes later.
-- Only the sync (service key) can read or write this table. Rows are never deleted.
create table if not exists public.notifications (
  id          bigserial primary key,
  notion_id   text not null,
  stage_index int not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  result      text
);
alter table public.notifications enable row level security;
