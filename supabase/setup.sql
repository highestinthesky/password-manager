-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- One row per user; the blob is the entire encrypted VaultFile.

create table if not exists public.vaults (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  blob       jsonb  not null,
  updated_at bigint not null
);

alter table public.vaults enable row level security;

-- Each user can only touch their own row. The anon key alone can do nothing.
create policy "own vault" on public.vaults
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
