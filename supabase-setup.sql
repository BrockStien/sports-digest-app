-- Daily Sports Digest: database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once.

-- One row per person, keyed to their sign-in account.
create table if not exists public.subscribers (
  id                       uuid primary key references auth.users (id) on delete cascade,
  email                    text not null,
  name                     text not null default '',
  active                   boolean not null default true,          -- false = paused, no emails
  leagues                  text[] not null default array['nfl','nhl','mlb','cfb','cbb'],
  favorite_teams           text[] not null default '{}',
  timezone                 text not null default 'America/Phoenix',
  headlines_per_league     int  not null default 3,
  favorites_only_headlines boolean not null default true,
  calendar_links           text not null default 'all',
  calendar_attachment      boolean not null default true,
  reminder_minutes         int  not null default 30,
  ticket_links             text not null default 'favorites',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Keep values sane even if someone pokes at the database directly.
  constraint leagues_valid   check (leagues <@ array['nfl','nba','nhl','mlb','cfb','cbb','ufc']),
  constraint calendar_valid  check (calendar_links in ('all','favorites','none')),
  constraint tickets_valid   check (ticket_links  in ('all','favorites','none')),
  constraint headlines_valid check (headlines_per_league between 0 and 10),
  constraint reminder_valid  check (reminder_minutes between 0 and 1440),
  constraint teams_limit     check (cardinality(favorite_teams) <= 60),
  constraint name_length     check (char_length(name) <= 60)
);

-- Keep updated_at current, and always use the email address the person signed in with,
-- so nobody can point the daily email at someone else's inbox.
create or replace function public.touch_updated_at() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  new.updated_at = now();
  select u.email into new.email from auth.users u where u.id = new.id;
  if new.email is null then
    raise exception 'No sign-in account for this subscriber';
  end if;
  return new;
end $$;

drop trigger if exists subscribers_touch on public.subscribers;
create trigger subscribers_touch before insert or update on public.subscribers
  for each row execute function public.touch_updated_at();

-- Security: everyone can only see and change their own row.
-- (The daily email job uses the secret service key, which bypasses this to read everyone.)
alter table public.subscribers enable row level security;

drop policy if exists "read own row"   on public.subscribers;
drop policy if exists "add own row"    on public.subscribers;
drop policy if exists "change own row" on public.subscribers;
drop policy if exists "delete own row" on public.subscribers;

create policy "read own row"   on public.subscribers for select using (auth.uid() = id);
create policy "add own row"    on public.subscribers for insert with check (auth.uid() = id);
create policy "change own row" on public.subscribers for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "delete own row" on public.subscribers for delete using (auth.uid() = id);
