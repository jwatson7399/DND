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
  resolved_at timestamptz,
  kept        boolean not null default false,
  deferred    boolean not null default false,
  resolution  text,
  edited_at   timestamptz,
  session     integer,
  constraint journal_notes_author_allowed
    check (author in ('Jotham', 'Soren', 'Aurelian', 'Erlathon', 'Therion', 'DM')),
  constraint journal_notes_body_length
    check (char_length(body) between 1 and 2000),
  constraint journal_notes_section_shape
    check (section ~ '^[a-z0-9-]{1,64}$'),
  constraint journal_notes_resolution_length
    check (resolution is null or char_length(resolution) between 1 and 300),
  constraint journal_notes_one_visible_state
    check (not (kept and deferred))
);

-- Note states, set by the maintainer only (anon cannot update):
--   open:     resolved = false, kept = false. Shows in the box and counts
--             toward the table of contents badge. Needs a decision.
--   kept:     kept = true. Stays visible for good (lore, jokes, useful
--             context) but no longer counts as a to-do.
--   deferred: deferred = true. Stays visible for now, and is folded into
--             the journal as canon at the next session rebuild, then
--             resolved. Does not count as a to-do in between.
--   resolved: resolved = true. Hidden behind "Resolved history" in the box,
--             struck through when expanded. resolution says what was done.

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
-- Stamp resolved_at when a note flips to resolved, clear it if reopened.
-- ---------------------------------------------------------------------------
create or replace function public.journal_notes_track_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.resolved and not old.resolved then
    new.resolved_at := now();
  elsif not new.resolved then
    new.resolved_at := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.journal_notes_track_resolved() from public, anon, authenticated;

drop trigger if exists journal_notes_track_resolved on public.journal_notes;
create trigger journal_notes_track_resolved
  before update on public.journal_notes
  for each row execute function public.journal_notes_track_resolved();

-- ---------------------------------------------------------------------------
-- Row level security. The page uses the anon key only.
--   select: everyone can read every row.
--   insert: allowed when author is on the list, body is 1 to 2000 chars,
--           and the note starts open (resolved false, kept false,
--           deferred false, no resolution text).
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
    author in ('Jotham', 'Soren', 'Aurelian', 'Erlathon', 'Therion', 'DM')
    and char_length(body) between 1 and 2000
    and resolved = false
    and kept = false
    and deferred = false
    and resolution is null
  );

-- Belt and braces: even if a policy is added by mistake later, anon and
-- authenticated cannot update or delete at the privilege level.
revoke update, delete, truncate on public.journal_notes from anon, authenticated;
grant select, insert on public.journal_notes to anon;

-- ---------------------------------------------------------------------------
-- Owner edits without logins. When the page posts a note it generates a
-- random token, keeps it in that browser's localStorage, and sends it along.
-- Only the sha256 of the token is stored, in a table with no API access.
-- edit_note checks the token and lets the body change while the note is
-- not yet resolved (kept and deferred notes are still editable). Both
-- functions run as security definer on purpose; anon can execute them and
-- nothing else touches journal_note_secrets.
-- ---------------------------------------------------------------------------
create table if not exists public.journal_note_secrets (
  note_id    uuid primary key references public.journal_notes(id) on delete cascade,
  token_hash text not null
);
alter table public.journal_note_secrets enable row level security;
revoke all on public.journal_note_secrets from anon, authenticated;

create or replace function public.add_note(
  p_section text, p_author text, p_body text, p_session integer, p_token text
)
returns public.journal_notes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n public.journal_notes;
begin
  if p_token is null or char_length(p_token) < 32 then
    raise exception 'edit token missing' using errcode = 'check_violation';
  end if;
  insert into public.journal_notes (section, author, body, session)
  values (p_section, p_author, p_body, p_session)
  returning * into n;
  insert into public.journal_note_secrets (note_id, token_hash)
  values (n.id, encode(digest(p_token, 'sha256'), 'hex'));
  return n;
end;
$$;

create or replace function public.edit_note(p_id uuid, p_token text, p_body text)
returns public.journal_notes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n public.journal_notes;
  h text;
begin
  select token_hash into h from public.journal_note_secrets where note_id = p_id;
  if h is null or p_token is null or h <> encode(digest(p_token, 'sha256'), 'hex') then
    raise exception 'not your note: only the browser that posted a note can edit it'
      using errcode = 'insufficient_privilege';
  end if;
  update public.journal_notes
  set body = p_body, edited_at = now()
  where id = p_id and resolved = false
  returning * into n;
  if n.id is null then
    raise exception 'note is resolved and can no longer be edited'
      using errcode = 'check_violation';
  end if;
  return n;
end;
$$;

revoke execute on function public.add_note(text, text, text, integer, text) from public, authenticated;
revoke execute on function public.edit_note(uuid, text, text) from public, authenticated;
grant execute on function public.add_note(text, text, text, integer, text) to anon;
grant execute on function public.edit_note(uuid, text, text) to anon;

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
