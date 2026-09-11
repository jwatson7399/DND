# DND: Season 2 campaign journal

A static campaign journal for the Thornhaven season, hosted on GitHub Pages, with a shared notes box in every section so the party can flag corrections and missed details. No logins. Notes are stored in a Supabase table and survive every republish of the journal.

**Live site:** https://jwatson7399.github.io/DND/

## What is in the repo

| file | purpose |
|------|---------|
| `index.html` | The journal itself, served from the repo root by GitHub Pages. Regenerated after each session. |
| `notes.js` | The notes feature. Finds sections by id at runtime and injects a notes box into each. |
| `notes.css` | Styling for the notes boxes and the table of contents badges. Uses the journal's CSS variables. |
| `supabase/schema.sql` | The exact table, constraints, trigger, and RLS policies. Recreates the backend from scratch. |
| `RESOLVE_NOTES.md` | The standard procedure for turning notes into journal updates, written for an agent or a human. |
| `CLAUDE.md` | House rules for agents working in this repo, and the pointer to the resolve workflow. |
| `.nojekyll` | Tells GitHub Pages to serve files as they are, no Jekyll processing. |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | The tab and home screen icon: a gold d20 on the journal's dark parchment. Linked from the head of `index.html`. |

GitHub Pages is enabled from the `main` branch, root folder. Pushing to `main` redeploys within a minute or two.

## How notes work

Every major section (Campaign at a glance, Story so far, The party, Quests, NPCs, Locations, Enemies, Current state, Lessons, Table notes), every session block, and a General box at the end of the page has a notes area at its bottom. On top of that, every card (each character, quest, NPC, location, and enemy) and every numbered kill in the kill recaps has its own compact "Add note" control, so a correction or an extra detail can be left right on the thing it is about.

Each notes area shows:

- Existing notes, oldest first, with author, relative time, body, and a status tag. Open notes show a red "open" tag. Kept notes show a blue "kept" tag and stay visible. Notes deferred to the next rebuild show a gold "next rebuild" tag and stay visible until then. Resolved notes are hidden behind a "Resolved history (n)" toggle and render dimmed and struck through when expanded, with a one-line resolution under each.
- An "Add note" button. Clicking it opens the compose form: a "Posting as" dropdown with the six allowed authors (Jotham, Soren, Aurelian, Erlathon, Therion, DM), a textarea, an "Add note" submit button, and Cancel. The author choice is saved in the browser (localStorage), preselected next time, and shared by every form on the page. You must pick a name before posting.
- The submit button is disabled while the request is in flight. Success appends the note, clears the box, and collapses the form. Failure shows a one-line message under the button.

Section ids: notes on a section use its HTML id (`quests`, `session-0`, `general`). Notes on a card use `<section>--<slug of the card name>`, for example `party--jotham` or `npcs--solara`. Notes on a kill recap use `enemies--kills-<character>-<kill number>`, for example `enemies--kills-jotham-1`; a character with no kills yet has one control at `enemies--kills-<character>`. Kill numbers follow the order of the list, so always append new kills at the bottom. If a card is renamed or removed when the journal is regenerated, its notes are not lost: they show up in the parent section's list instead.

Loading: one query fetches every note on page load and groups them by section in the browser. Open pages subscribe to Supabase realtime for instant updates from other players and also poll every 60 seconds (and whenever the tab regains focus), so a missed realtime event is picked up within a minute. If Supabase is unreachable the journal still renders fully and each box says "Notes unavailable".

Every note is in one of four states, set by the maintainer only:

- **open**: shown in the box, counts toward the badge in the table of contents. A pending decision.
- **kept**: shown with a "kept" tag, does not count toward the badge. For jokes, in-character objections, and context that should stay visible as is.
- **deferred**: shown with a "next rebuild" tag, does not count toward the badge. The decision is made: the fact becomes canon when the next session is added, and the note is resolved then. Until that rebuild it stays as a visible note on the current journal.
- **resolved**: hidden behind "Resolved history", struck through when expanded, with the resolution line underneath. For notes that were folded into the journal or needed no change.

The table of contents shows a gold count badge next to any section with open notes so the maintainer can see where the pending decisions are.

Where the page finds its Supabase project: the last `<script>` tag in `index.html` carries `data-supabase-url` and `data-supabase-key`. The anon key is public by design; it can only do what the RLS policies below allow. The service role key must never be committed.

## Updating the journal after a session

The maintainer (Julian, working with Claude in the DnD project) regenerates the journal from the audio transcript plus the party's notes. The step-by-step procedure for the notes half of that, including the multiple-choice question format an agent should use, is in `RESOLVE_NOTES.md`. Asking Claude (or any agent with this repo and Supabase access) to "resolve notes" should trigger it; `CLAUDE.md` in this repo points there.

Outline:

1. **Read the open notes, and at a rebuild the deferred notes too.** Open means `resolved = false`, `kept = false`, `deferred = false`. In the Supabase dashboard (Table Editor, `journal_notes`) or through the Supabase connector:
   ```sql
   select id, section, session, author, body, created_at
   from journal_notes
   where resolved = false and kept = false and deferred = false
   order by section, created_at;
   ```
2. **Decide each note with Julian.** Fold it in now, fold it in at the next rebuild, keep it visible, resolve without changes, or skip. Deferred notes from earlier rounds are folded in as canon without asking again.
3. **Update the journal content.** Fold corrections into the right sections, add the new session block (copy the Session 0 structure and add a matching link in the sidebar), and touch whatever the session changed:
   - Session minutes: fill the next `details.session` block (Summary, Minutes, Roleplay moments, Rolls), add a new placeholder block below it, and add a matching sidebar link.
   - Story so far: one new paragraph under an "After Session N" heading.
   - The party: append a "Session N:" line to each character's log and update level, HP, and abilities.
   - Quests: update status pills and log lines, add new quests as cards.
   - NPCs, Locations, Enemies: add cards for anything new, append to existing ones.
   - Current state: rewrite entirely so it describes only the latest end-of-session position.
   - Lessons and tactics: add anything the DM said or the fight taught.
   - Campaign at a glance: bump the session count and any changed facts.
   - Kill count (top of Enemies encountered): bump the table, then add a numbered entry to that character's `details.kill` recap describing the kill. Cinematic and funny is the house style. Characters with no kills keep a "closest call" paragraph instead.
4. **Mark the notes.** One update per note, with a short `resolution` line:
   ```sql
   update journal_notes set resolved = true, resolution = 'Folded into Quests' where id = '...';
   update journal_notes set kept = true, resolution = 'Kept as party lore' where id = '...';
   update journal_notes set deferred = true, resolution = 'Canon from Session 1: ...' where id = '...';
   ```
   `resolved_at` is stamped by a trigger. Never delete notes.
5. **Replace `index.html`, commit, push.** Pages redeploys automatically.

When regenerating `index.html`, keep two things from the current file so the notes feature keeps working:

- In `<head>`: `<link rel="stylesheet" href="notes.css">`
- At the end of `<body>`, the three lines marked `Notes feature`: the Supabase JS CDN script and the `notes.js` script tag with its two data attributes.
- Also in `<head>`, the three icon `<link>` tags and the `theme-color` meta, so the tab keeps the d20 icon instead of borrowing another site's favicon from the shared jwatson7399.github.io origin.

Nothing else in the journal needs to know about notes. `notes.js` discovers sections by their ids at runtime (`overview`, `story-so-far`, `party`, `quests`, `npcs`, `locations`, `enemies`, `state`, `lessons`, `table`, plus every `details.session` whose id starts with `session-`) and every `.card` with a `.name` inside those sections, so new session blocks and new cards get an Add note control automatically. Keep the section ids stable or old notes will stop lining up with their sections.

Quick check after pushing: open the live URL, confirm the badges and boxes appear, and post a test note as DM.

## Supabase schema and policies

Full SQL is in `supabase/schema.sql`. Summary:

Table `journal_notes`:

| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, default `gen_random_uuid()` |
| created_at | timestamptz | default `now()` |
| section | text | not null. The section id in the HTML, or `<section>--<card slug>` for a card. Checked against `^[a-z0-9-]{1,64}$`. |
| author | text | not null. Check constraint: one of Jotham, Soren, Aurelian, Erlathon, Therion, DM. |
| body | text | not null. Check constraint: length 1 to 2000. |
| resolved | boolean | not null, default false. Set by the maintainer only. Hidden behind Resolved history on the page. |
| resolved_at | timestamptz | nullable. Stamped by a trigger when resolved flips to true, cleared if reopened. |
| kept | boolean | not null, default false. Set by the maintainer only. Stays visible, does not count as a to-do. |
| deferred | boolean | not null, default false. Set by the maintainer only. Stays visible, does not count as a to-do, folded in as canon at the next rebuild. Cannot be true together with kept. |
| resolution | text | nullable, 1 to 300 characters. What was done with the note. Shown under it in the history. |
| session | integer | nullable. Set automatically for notes posted inside a session block. |

Row level security is on. Policies for the `anon` role:

- `select`: all rows.
- `insert`: allowed when `author` is in the allowed list, `body` length is 1 to 2000, and the note starts open: `resolved = false`, `kept = false`, `deferred = false`, `resolution` null.
- No `update` or `delete` policy. In addition, `update`, `delete`, and `truncate` privileges are revoked from `anon` and `authenticated`, so resolving or removing notes can only happen from the dashboard or with the service role key.

Rate limit: a `before insert` trigger (`journal_notes_rate_limit`) rejects the row when the same author already has 20 or more notes in the last 10 minutes. The page turns that error into a one-line "slow down" message. The function runs as `security definer` with `execute` revoked from `anon` and `authenticated`, so it cannot be called over the API.

A second trigger (`journal_notes_track_resolved`) stamps `resolved_at` when a note is resolved and clears it if reopened. Both trigger functions have `execute` revoked from `anon` and `authenticated`.

Realtime: the table is added to the `supabase_realtime` publication so open pages get inserts and state changes without a refresh.

### Recreating the backend

1. Create a free Supabase project.
2. Open the SQL editor and run `supabase/schema.sql`.
3. Copy the project URL and anon (publishable) key from Project Settings, API.
4. Paste them into the `data-supabase-url` and `data-supabase-key` attributes on the `notes.js` script tag in `index.html`, commit, push.

### Verifying the policies from the command line

Replace the URL and key with the values from `index.html`.

```sh
URL=https://YOUR_PROJECT.supabase.co
KEY=YOUR_ANON_KEY

# Allowed insert
curl -s "$URL/rest/v1/journal_notes" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"section":"general","author":"DM","body":"curl test"}'

# Rejected: author not on the list
curl -s "$URL/rest/v1/journal_notes" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"section":"general","author":"Bob","body":"nope"}'

# Rejected: update and delete
curl -s -X PATCH "$URL/rest/v1/journal_notes?author=eq.DM" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"resolved":true}'
curl -s -X DELETE "$URL/rest/v1/journal_notes?author=eq.DM" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

## House rules for files in this repo

- No em dashes anywhere. Use commas, colons, or periods.
- No build step, no framework, no bundler. One HTML file, one JS file, one CSS file, and the Supabase client from a CDN.
- The service role key never appears here. Check with `git grep service_role` before pushing anything new.
