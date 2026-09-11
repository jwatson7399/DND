# Handoff: let Cowork sessions push to the DND repo

## Goal

Cowork (Claude in the desktop app) can already edit files in `/Users/julian/Claude Code/DND` and commit locally, but it cannot push: its shell has no GitHub credentials. Set up a repo-scoped token on the local clone so future Cowork sessions can run `git push` without Claude Code. Also push the commit that is already waiting.

## Steps

1. Push the pending commit first. In `/Users/julian/Claude Code/DND`, confirm `git log --oneline -1` shows `d09bc27 Remove how-to section so party notes are last on the page`, then `git push origin main`. Verify https://jwatson7399.github.io/DND/ no longer has a "How to add a session" section (allow a minute for Pages).

2. Create a fine-grained personal access token. This must be done in the GitHub web UI by Julian; walk him through it and open the page for him if possible: https://github.com/settings/personal-access-tokens/new
   - Token name: `cowork-dnd-journal`
   - Expiration: 1 year (or the longest offered)
   - Repository access: Only select repositories, choose `jwatson7399/DND`
   - Repository permissions: Contents, Read and write. Metadata will be added automatically as read only. Nothing else.
   - Ask Julian to paste the token into the terminal session, not into any file that gets committed.

3. Store the token on the local clone only. Do not use the global credential helper and do not write the token to any file inside the working tree. Two acceptable options; use the first:
   - Set the remote URL to embed the token: `git remote set-url origin https://<TOKEN>@github.com/jwatson7399/DND.git`. This lands in `.git/config`, which is never committed.
   - Or a repo-local credential store: `git config credential.helper "store --file .git/cowork-credentials"` and write `https://jwatson7399:<TOKEN>@github.com` to that file with mode 600.

4. Verify from a shell that has no other GitHub credentials available. Temporarily set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`, then run `git ls-remote origin` and `git push --dry-run origin main`. Both must succeed using only the repo-local config.

5. Confirm nothing leaked: `git grep -I "github_pat_" -- .` returns nothing, and `.git/config` (or the credential file) is the only place the token appears. Add `.git/cowork-credentials` to nothing; it is already outside the working tree.

6. Tell Julian the one thing Claude Code cannot fix: the Cowork sandbox also has a network allowlist that currently blocks github.com (the proxy returns 403). He needs to add github.com to the allowed domains in his Claude account settings for Cowork or Claude Code cloud sessions. Until that is done the token alone is not enough, and the fallback is that Cowork commits locally and Julian runs `git push` himself.

## Acceptance

- Commit `d09bc27` is on `origin/main` and the live page ends with the general party notes box.
- A fine-grained token scoped to Contents read and write on `jwatson7399/DND` only exists and expires in about a year.
- `git push --dry-run` succeeds with global and system git config disabled.
- The token appears nowhere in the working tree or in any commit.
- Julian has been told about the network allowlist step and where to find it if known.
