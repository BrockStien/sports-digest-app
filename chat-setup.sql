-- Sports Digest group chat: database setup
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Needs supabase-setup.sql to have been run first.

-- ---------------------------------------------------------------- tables
create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references auth.users (id) on delete cascade,
  invite_code text not null unique default substr(md5(gen_random_uuid()::text), 1, 12),
  created_at  timestamptz not null default now(),
  constraint group_name_length check (char_length(btrim(name)) between 1 and 40)
);

create table if not exists public.group_members (
  group_id     uuid not null references public.groups (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  role         text not null default 'member',
  chat_notify  text not null default 'mentions',     -- all | mentions | off (each person's choice, per group)
  last_read_at timestamptz not null default now(),
  joined_at    timestamptz not null default now(),
  primary key (group_id, user_id),
  constraint member_role_valid   check (role in ('owner', 'member')),
  constraint member_notify_valid check (chat_notify in ('all', 'mentions', 'off')),
  constraint member_name_length  check (char_length(btrim(display_name)) between 1 and 40)
);
create index if not exists group_members_user on public.group_members (user_id);

create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  group_id     uuid not null references public.groups (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  thread       text not null default 'general',    -- 'general' or a game, e.g. 'nhl:401802233'
  thread_title text not null default '',            -- e.g. 'Wild @ Flames · Thu, Nov 5'
  body         text not null,
  deleted      boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint thread_valid      check (thread = 'general' or thread ~ '^[a-z]{3,4}:[0-9]{1,15}$'),
  constraint thread_title_size check (char_length(thread_title) <= 80),
  constraint body_length       check (deleted or char_length(btrim(body)) between 1 and 1000)
);
create index if not exists messages_group_thread on public.messages (group_id, thread, created_at desc);
create index if not exists messages_recent on public.messages (created_at);

-- ---------------------------------------------------------------- helpers
-- "Is the signed-in person in this group?" (security definer avoids rule loops)
create or replace function public.is_member(g uuid) returns boolean
language sql volatile security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = auth.uid())
$$;
create or replace function public.is_owner(g uuid) returns boolean
language sql volatile security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = g and user_id = auth.uid() and role = 'owner')
$$;

-- Whoever creates a group becomes its owner (name taken from their Sports Digest name).
create or replace function public.add_group_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  select coalesce(nullif(btrim(s.name), ''), split_part(u.email, '@', 1)) into nm
    from auth.users u left join public.subscribers s on s.id = u.id where u.id = new.created_by;
  insert into public.group_members (group_id, user_id, display_name, role)
    values (new.id, new.created_by, left(coalesce(nm, 'Me'), 40), 'owner');
  return new;
end $$;
drop trigger if exists groups_add_owner on public.groups;
create trigger groups_add_owner after insert on public.groups for each row execute function public.add_group_owner();

-- Join with an invite code. Returns the group id.
create or replace function public.join_group(code text, name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid; n int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into g from public.groups where invite_code = lower(btrim(code));
  if g is null then raise exception 'That invite link isn''t valid anymore. Ask for a new one.'; end if;
  if exists (select 1 from public.group_members where group_id = g and user_id = auth.uid()) then return g; end if;
  select count(*) into n from public.group_members where group_id = g;
  if n >= 50 then raise exception 'This group is full (50 people).'; end if;
  insert into public.group_members (group_id, user_id, display_name)
    values (g, auth.uid(), left(coalesce(nullif(btrim(name), ''), 'Fan'), 40));
  return g;
end $$;

-- Owner only: make a new invite link (the old one stops working).
create or replace function public.new_invite_code(g uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := substr(md5(gen_random_uuid()::text), 1, 12);
begin
  if not public.is_owner(g) then raise exception 'Only the group owner can do that'; end if;
  update public.groups set invite_code = c where id = g;
  return c;
end $$;

-- Messages: always from the signed-in person, and no spamming (max 20 a minute).
create or replace function public.check_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := coalesce(auth.uid(), new.user_id);   -- signed-in people always post as themselves
    new.deleted := false;
    new.created_at := now();
    if (select count(*) from public.messages where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
      raise exception 'Slow down! Too many messages in a minute.';
    end if;
  else  -- UPDATE: the only change allowed is deleting (blanking) a message
    if new.body is distinct from old.body and not new.deleted then raise exception 'Messages can''t be edited'; end if;
    new.id := old.id; new.group_id := old.group_id; new.user_id := old.user_id;
    new.thread := old.thread; new.thread_title := old.thread_title; new.created_at := old.created_at;
    if new.deleted then new.body := ''; end if;
  end if;
  return new;
end $$;
drop trigger if exists messages_check on public.messages;
create trigger messages_check before insert or update on public.messages for each row execute function public.check_message();

-- Members can only change their own name, alert choice and read marker (not their role).
create or replace function public.check_member_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.role is distinct from old.role then raise exception 'Can''t change roles'; end if;
  new.group_id := old.group_id; new.user_id := old.user_id; new.joined_at := old.joined_at;
  return new;
end $$;
drop trigger if exists members_check on public.group_members;
create trigger members_check before update on public.group_members for each row execute function public.check_member_update();

-- The owner can't just leave (the group would have nobody in charge); they delete the group instead.
create or replace function public.check_member_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'owner' and exists (select 1 from public.groups where id = old.group_id) then
    raise exception 'The owner can''t leave. Delete the group instead.';
  end if;
  return old;
end $$;
drop trigger if exists members_delete_check on public.group_members;
create trigger members_delete_check before delete on public.group_members for each row execute function public.check_member_delete();

-- ---------------------------------------------------------------- security rules
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.messages      enable row level security;

drop policy if exists "see my groups"    on public.groups;
drop policy if exists "create a group"   on public.groups;
drop policy if exists "owner renames"    on public.groups;
drop policy if exists "owner deletes"    on public.groups;
create policy "see my groups"  on public.groups for select using (created_by = auth.uid() or public.is_member(id));
create policy "create a group" on public.groups for insert with check (created_by = auth.uid());
create policy "owner renames"  on public.groups for update using (public.is_owner(id)) with check (public.is_owner(id));
create policy "owner deletes"  on public.groups for delete using (public.is_owner(id));

drop policy if exists "see group members"       on public.group_members;
drop policy if exists "update my membership"    on public.group_members;
drop policy if exists "leave or owner removes"  on public.group_members;
create policy "see group members"      on public.group_members for select using (public.is_member(group_id));
create policy "update my membership"   on public.group_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "leave or owner removes" on public.group_members for delete using (user_id = auth.uid() or public.is_owner(group_id));
-- (Joining goes through join_group(); creating a group adds the owner automatically.)

drop policy if exists "read group messages"          on public.messages;
drop policy if exists "post to my groups"            on public.messages;
drop policy if exists "delete own or owner deletes"  on public.messages;
create policy "read group messages" on public.messages for select using (public.is_member(group_id));
create policy "post to my groups"   on public.messages for insert with check (public.is_member(group_id));
create policy "delete own or owner deletes" on public.messages for update
  using (user_id = auth.uid() or public.is_owner(group_id)) with check (public.is_member(group_id));

-- The game watcher remembers which messages it has already sent alerts for.
create table if not exists public.notify_meta (key text primary key, value text not null);
alter table public.notify_meta enable row level security;

-- ---------------------------------------------------------------- live updates
-- New messages show up instantly in the app (Supabase Realtime). Skipped quietly if not available.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object or undefined_object then null;
end $$;

-- ---------------------------------------------------------------- lock down helper functions
-- Trigger-only functions: nobody needs to call these directly (triggers still fire normally).
revoke execute on function public.add_group_owner()     from public, anon, authenticated;
revoke execute on function public.check_member_delete() from public, anon, authenticated;
revoke execute on function public.check_member_update() from public, anon, authenticated;
revoke execute on function public.check_message()       from public, anon, authenticated;
revoke execute on function public.touch_updated_at()    from public, anon, authenticated;
-- Used by the chat security rules and the app: signed-in people only.
revoke execute on function public.is_member(uuid)        from public, anon;
revoke execute on function public.is_owner(uuid)         from public, anon;
revoke execute on function public.join_group(text, text) from public, anon;
revoke execute on function public.new_invite_code(uuid)  from public, anon;
grant  execute on function public.is_member(uuid)        to authenticated;
grant  execute on function public.is_owner(uuid)         to authenticated;
grant  execute on function public.join_group(text, text) to authenticated;
grant  execute on function public.new_invite_code(uuid)  to authenticated;
