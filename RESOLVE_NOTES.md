# Resolve notes: the workflow

This is the standard procedure for turning the party's notes into journal updates. It is written for an agent (Claude or any other) that has been asked to "resolve notes" on this repo, and for Julian to follow by hand if needed.

The short version: read the open notes, ask Julian what to do with each one using multiple-choice questions, apply the answers to `index.html` and to the `journal_notes` table, push. There are two moments this runs: a quick pass any time ("resolve notes"), and the full pass when a new session is added ("rebuild"), which also folds in everything that was deferred.

## What you need

- This repo checked out, on `main`, clean working tree.
- A way to read and update the `journal_notes` table in the Supabase project `dnd-journal` (ref `zamizuofpfleamcwplmi`). Use the Supabase connector or the dashboard SQL editor. The anon key in `index.html` cannot update rows by design, so do not try to use it for step 4.
- The service role key must never be written into any file in this repo.

## Note states

| state | columns | what the page does |
|-------|---------|--------------------|
| open | `resolved = false`, `kept = false` | Shown in the section's notes box. Counts toward the badge in the table of contents. This is a pending decision. |
| kept | `kept = true` | Shown in the box with a blue "kept" tag. Does not count toward the badge. For notes that are funny, in character, or informative and should stay visible as is. |
| deferred | `deferred = true` | Shown in the box with a gold "next rebuild" tag. Does not count toward the badge. The decision is made: the note becomes canon when the next session is added to the journal, and is resolved then. Until that rebuild it stays visible as a note on the current journal. |
| resolved | `resolved = true` | Hidden behind "Resolved history (n)" in the box. Struck through when expanded, with the `resolution` text underneath. For notes whose content was folded into the journal, or that needed no change. |

`resolved_at` is stamped automatically by a trigger. `resolution` is a short line (up to 300 characters) saying what happened, shown in the history. Always fill it in.

Authors can edit their own notes from the browser they posted from until the note is resolved, so re-read a note's current `body` right before folding it in rather than trusting an earlier copy. `edited_at` tells you if it changed.

## Steps

### 1. Read the repo

Read `README.md` and skim `index.html` so you know the sections, the card names, and the house style (no em dashes, cinematic kill recaps, the journal's voice). Do not touch `notes.js` or `notes.css` during this workflow.

### 2. Pull the open notes

```sql
select id, section, session, author, body, created_at
from journal_notes
where resolved = false and kept = false and deferred = false
order by section, created_at;
```

If this is a rebuild (a new session is being added), also pull the deferred notes. They are not questions, they are instructions:

```sql
select id, section, session, author, body, resolution, created_at
from journal_notes
where deferred = true and resolved = false
order by section, created_at;
```

The `section` column tells you where the note was posted:

- a section id such as `quests`, `state`, `session-0`, `general`
- a card: `party--jotham`, `npcs--solara`, `locations--thornhaven`
- a kill recap entry: `enemies--kills-jotham-1` (character, kill number) or `enemies--kills-soren` (closest-call paragraph, no kills yet)

If there are no open notes, say so and stop.

### 3. Ask Julian, one note at a time

Present the notes as a series of multiple-choice questions. Use the harness's ask-the-user tool if there is one (AskUserQuestion in Claude Code); otherwise write the same structure in plain text and wait for answers. Group by section and keep the original order within a section.

Each question quotes the note in full with its author, section, and age, then offers exactly these options:

1. **Fold it in now.** Edit the journal so the section reflects the note, then mark the note resolved. Say in one line what edit you would make, so Julian can correct the interpretation before you touch anything.
2. **Fold it in at the next rebuild.** Mark the note `deferred`, with a resolution line that states the canonical fact in one sentence, for example "Canon from Session 1: Jotham did not volunteer as party leader." No edit now. The note stays visible on the current journal, and the rebuild incorporates the fact and resolves it. Use this when the note is true and should become canon, but reads well as a note on this session's journal until the next one is written.
3. **Keep it visible.** Mark the note `kept`. No edit, ever. This is the right answer for jokes, in-character objections, and useful context that is not a correction. It always has to be on the list.
4. **Resolve without changes.** Mark resolved with a resolution such as "Already covered in Session 1 minutes" or "Duplicate of an earlier note". No edit.
5. **Skip for now.** Leave it open. Ask nothing more about it this round.

Do not batch decisions or assume an answer. If Julian gives a free-text answer instead of picking an option, treat it as instructions for option 1 and confirm the edit you plan to make.

Deferred notes are never re-asked. At a rebuild, list them once as "folding in as canon" with their resolution lines so Julian can veto any, then fold them all in.

For notes on kill recaps, "fold it in" means adding the detail to that character's numbered kill entry (or the closest-call paragraph), keeping the cinematic tone. For a note that says a kill happened that is not in the table, update the kill count table, the party total, and add a numbered entry to that character's `details.kill` list, at the bottom.

### 4. Apply the decisions

Make all `index.html` edits first, then update the table, then commit. That order means a failed edit never leaves a note marked resolved with nothing to show for it.

Editing rules:

- Fold corrections into the right section in the journal's voice. Do not paste the note text in verbatim unless it is a quote worth keeping.
- Add new session blocks, cards, and kill entries following the existing markup. Keep section ids stable.
- No em dashes anywhere. Use commas, colons, or periods.
- Keep the `notes.css` link in the head, the icon links, and the two script tags at the end of body. They are what make the notes feature work.

Table updates, one statement per note, using the ids from step 2:

```sql
-- Fold it in, or resolve without changes
update journal_notes
set resolved = true, resolution = 'Folded into Quests: the road task was Solara''s, not the council''s'
where id = '00000000-0000-0000-0000-000000000000';

-- Fold it in at the next rebuild
update journal_notes
set deferred = true, resolution = 'Canon from Session 1: Jotham did not volunteer as party leader'
where id = '00000000-0000-0000-0000-000000000000';

-- Keep it visible
update journal_notes
set kept = true, resolution = 'Kept: in character, stays as party lore'
where id = '00000000-0000-0000-0000-000000000000';

-- At a rebuild, after a deferred note has been folded in
update journal_notes
set resolved = true, deferred = false, resolution = resolution || '. Folded in at the Session 1 rebuild.'
where id = '00000000-0000-0000-0000-000000000000';
```

Never delete notes. Never update rows Julian did not decide on this round.

### 5. Verify and ship

1. `grep -rn $'\xe2\x80\x94' --exclude-dir=.git .` (searches for the em dash byte sequence) must print nothing.
2. Open `index.html` locally (any static server) and check the edited sections render and the badge counts dropped where expected.
3. Commit with a message that lists the notes handled, for example `Resolve 3 notes: fold Quests correction, keep Jotham objection, resolve duplicate`. End the message with the attribution lines the harness gave you, if any.
4. Push to `main`. GitHub Pages redeploys within about a minute.
5. Report back: which notes were folded, kept, resolved, or skipped, and the live URL.

## The rebuild (adding a new session)

When Julian gives you a new session transcript and asks for the journal to be updated, run this workflow as part of it, in this order:

1. Pull open notes and deferred notes (step 2 above).
2. Ask about the open notes (step 3). Deferred notes are listed for veto only.
3. Write the new session block and all the section updates the README lists, treating every deferred note's resolution line as an established fact. Rewrite the affected sections so the canonical version reads as if it had always been true; do not leave "correction:" phrasing in the journal body.
4. Apply the open-note decisions (step 4), then mark every folded deferred note resolved with `deferred = false` and the rebuild appended to its resolution.
5. Verify and ship (step 5).

## Doing it by hand

Julian can do all of this without an agent: read open notes in the Supabase Table Editor (filter `resolved = false`, `kept = false`, `deferred = false`), edit `index.html`, set `kept`, `deferred`, or `resolved` plus `resolution` on each row in the editor, commit, push.
