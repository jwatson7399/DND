# DND campaign journal

Static Season 2 campaign journal on GitHub Pages with party notes stored in Supabase. `README.md` explains the layout, the notes feature, and the schema.

## When asked to "resolve notes"

Follow `RESOLVE_NOTES.md` exactly. In short: read the open notes from the `journal_notes` table, ask Julian about each one with multiple-choice questions (fold it in now, fold it in at the next rebuild, keep it visible, resolve without changes, skip), apply the answers to `index.html` and the table, verify, commit, push.

## When adding a new session (a rebuild)

Follow the rebuild section of `RESOLVE_NOTES.md`: deferred notes become canon in the rewritten sections and are then resolved, open notes get asked about as usual.

## House rules

- No em dashes anywhere in this repo. Use commas, colons, or periods.
- `notes.js` and `notes.css` are the notes feature. Journal content changes go in `index.html` only.
- Keep section ids, card names, and the head and end-of-body tags stable when editing `index.html`.
- Never commit the Supabase service role key. The anon key in `index.html` is public by design.
- Never delete rows from `journal_notes`. Resolve or keep them.
