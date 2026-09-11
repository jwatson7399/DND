-- Journal notes for the DND campaign journal.
-- Run this in the Supabase SQL editor (or via the Supabase connector) on a
-- fresh project to recreate the table, constraints, policies, and rate limit.
-- Everything here is idempotent enough to re-run after a partial failure.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.journal_notes (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  section     text not null,
  author      text not null,
  body        text not null,
  resolved    boolean not null default false,
  session     integer,
  constraint journal_notes_author_allowed
    check (author in ('Jotham', 'Soren', 'Aurelian', 'Erlathon', 'Durian', 'DM')),
  constraint journal_notes_body_length
    check (char_length(body) between 1 and 2000),
  constraint journal_notes_section_shape
    check (section ~ '^[a-z0-9-]{1,64}$')
);

comment on table public.journal_notes is
  'Party corrections and additions to the campaign journal. section matches the HTML section id.';

create index if not exists journal_notes_section_idx on public.journal_notes (section, created_at);
create index if not exists journal_notes_author_recent_idx on public.journal_notes (author, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate limit: reject an insert when the same author already has more than
-- 20 notes in the last 10 minutes. Five-person group, so this only stops
-- runaway scripts and accidental paste loops.
-- ---------------------------------------------------------------------------
create or replace function public.journal_notes_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent integer;
begin
  select count(*) into recent
  from public.journal_notes
  where author = new.author
    and created_at > now() - interval '10 minutes';

  if recent >= 20 then
    raise exception 'rate limit: % has posted too many notes in the last 10 minutes', new.author
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Triggers fire regardless of execute privilege, so nobody needs to call this
-- directly. Revoking execute keeps it off the public RPC surface.
revoke execute on function public.journal_notes_rate_limit() from public, anon, authenticated;

drop trigger if exists journal_notes_rate_limit on public.journal_notes;
create trigger journal_notes_rate_limit
  before insert on public.journal_notes
  for each row execute function public.journal_notes_rate_limit();

-- ---------------------------------------------------------------------------
-- Row level security. The page uses the anon key only.
--   select: everyone can read every row.
--   insert: allowed when author is on the list, body is 1 to 2000 chars,
--           and resolved is false.
--   update and delete: nobody through the API. The maintainer resolves or
--   removes notes from the Supabase dashboard (or a connector using the
--   service role), which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.journal_notes enable row level security;

drop policy if exists "journal_notes anon select" on public.journal_notes;
create policy "journal_notes anon select"
  on public.journal_notes
  for select
  to anon
  using (true);

drop policy if exists "journal_notes anon insert" on public.journal_notes;
create policy "journal_notes anon insert"
  on public.journal_notes
  for insert
  to anon
  with check (
    author in ('Jotham', 'Soren', 'Aurelian', 'Erlathon', 'Durian', 'DM')
    and char_length(body) between 1 and 2000
    and resolved = false
  );

-- Belt and braces: even if a policy is added by mistake later, anon and
-- authenticated cannot update or delete at the privilege level.
revoke update, delete, truncate on public.journal_notes from anon, authenticated;
grant select, insert on public.journal_notes to anon;

-- ---------------------------------------------------------------------------
-- Realtime: lets open pages receive inserts and resolved changes instantly.
-- The page also polls every 60 seconds, so this is a nicety, not a requirement.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'journal_notes'
  ) then
    alter publication supabase_realtime add table public.journal_notes;
  end if;
end
$$;
