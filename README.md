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
| `.nojekyll` | Tells GitHub Pages to serve files as they are, no Jekyll processing. |

GitHub Pages is enabled from the `main` branch, root folder. Pushing to `main` redeploys within a minute or two.

## How notes work

Every major section (Campaign at a glance, Story so far, The party, Quests, NPCs, Locations, Enemies, Current state, Lessons, Table notes), every session block, and a General box at the end of the page has a notes area. Each one shows:

- Existing notes for that section, oldest first, with author, relative time, and body. Resolved notes are hidden behind a "show resolved (n)" toggle and render dimmed and struck through when shown.
- A "Posting as" dropdown with the six allowed authors: Jotham, Soren, Aurelian, Erlathon, Durian, DM. The choice is saved in the browser (localStorage) and preselected next time. You must pick a name before posting.
- A textarea and an "Add note" button. The button is disabled while the request is in flight. Success appends the note and clears the box. Failure shows a one-line message under the button.

Loading: one query fetches every note on page load and groups them by section in the browser. Open pages subscribe to Supabase realtime for instant updates from other players and also poll every 60 seconds (and whenever the tab regains focus), so a missed realtime event is picked up within a minute. If Supabase is unreachable the journal still renders fully and each box says "Notes unavailable".

The table of contents shows a gold count badge next to any section with unresolved notes so the maintainer can see where the corrections are.

Where the page finds its Supabase project: the last `<script>` tag in `index.html` carries `data-supabase-url` and `data-supabase-key`. The anon key is public by design; it can only do what the RLS policies below allow. The service role key must never be committed.

## Updating the journal after a session

The maintainer (Julian, working with Claude in the DnD project) regenerates the journal from the audio transcript plus the party's notes.

1. **Read the unresolved notes.** In the Supabase dashboard (Table Editor, `journal_notes`, filter `resolved = false`) or through the Supabase connector:
   ```sql
   select section, session, author, body, created_at
   from journal_notes
   where resolved = false
   order by section, created_at;
   ```
2. **Update the journal content.** Fold corrections into the right sections, add the new session block (copy the Session 0 structure and add a matching link in the sidebar), update characters, quests, NPCs, locations, enemies, and rewrite Current state. The "How to add a session" section at the bottom of the journal lists exactly what gets touched.
3. **Mark the folded notes resolved.**
   ```sql
   update journal_notes set resolved = true where resolved = false;
   ```
   Or resolve them one at a time in the Table Editor if some should stay open.
4. **Replace `index.html`, commit, push.** Pages redeploys automatically.

When regenerating `index.html`, keep two things from the current file so the notes feature keeps working:

- In `<head>`: `<link rel="stylesheet" href="notes.css">`
- At the end of `<body>`, the three lines marked `Notes feature`: the Supabase JS CDN script and the `notes.js` script tag with its two data attributes.

Nothing else in the journal needs to know about notes. `notes.js` discovers sections by their ids at runtime (`overview`, `story-so-far`, `party`, `quests`, `npcs`, `locations`, `enemies`, `state`, `lessons`, `table`, plus every `details.session` whose id starts with `session-`), so new session blocks get a notes box automatically. Keep those ids stable or old notes will stop lining up with their sections.

Quick check after pushing: open the live URL, confirm the badges and boxes appear, and post a test note as DM.

## Supabase schema and policies

Full SQL is in `supabase/schema.sql`. Summary:

Table `journal_notes`:

| column | type | notes |
|--------|------|-------|
| id | uuid | primary key, default `gen_random_uuid()` |
| created_at | timestamptz | default `now()` |
| section | text | not null. Matches the section id in the HTML. Checked against `^[a-z0-9-]{1,64}$`. |
| author | text | not null. Check constraint: one of Jotham, Soren, Aurelian, Erlathon, Durian, DM. |
| body | text | not null. Check constraint: length 1 to 2000. |
| resolved | boolean | not null, default false. Set by the maintainer only. |
| session | integer | nullable. Set automatically for notes posted inside a session block. |

Row level security is on. Policies for the `anon` role:

- `select`: all rows.
- `insert`: allowed when `author` is in the allowed list, `body` length is 1 to 2000, and `resolved = false`.
- No `update` or `delete` policy. In addition, `update`, `delete`, and `truncate` privileges are revoked from `anon` and `authenticated`, so resolving or removing notes can only happen from the dashboard or with the service role key.

Rate limit: a `before insert` trigger (`journal_notes_rate_limit`) rejects the row when the same author already has 20 or more notes in the last 10 minutes. The page turns that error into a one-line "slow down" message.

Realtime: the table is added to the `supabase_realtime` publication so open pages get inserts and resolved changes without a refresh.

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
