---
name: release
description: Release a new version of the brick-art plugin. Rebuilds the published parts database from the code being released, checks that it installs, bumps the plugin version, tags it, and publishes a GitHub release. Use when the user says "release", "cut a release", "ship a new version", "publish the plugin", or "/release".
---

# Release the brick-art plugin

A release ships new code together with a parts database built from that same code.
`npm run release` does the work (`src/release/plugin-release.ts`). This skill runs it, writes the
release notes, and gets the user's go-ahead before anything is published.

## What the script does

1. Checks that you are on `main`, the tree is clean, `main` matches `origin/main`, `gh` is signed in,
   and the version files agree. Runs `npm test` and `npm run typecheck`.
2. Starts the `data-release` workflow on `main` and waits for it. The build takes up to two hours.
3. Checks the newest `data-<schema>-<date>` release: its `release.json` must record that run and
   commit as its source, list both variants, and each variant's file must be attached. Then it
   installs the standard variant into a scratch data folder with the real updater.
4. Sets the version in `.claude-plugin/plugin.json`, `package.json`, and `package-lock.json`, commits
   `chore: release vX.Y.Z`, adds an annotated tag, and pushes `main` and the tag together.
   Before this, it checks that the checkout is still the tested commit with a clean tree.
5. Creates the `vX.Y.Z` GitHub release, marked latest. Custom notes get a line naming the data
   release appended; without them, the notes list the commits since the last tag.

It stops at the first failure. Nothing is committed or pushed before step 4.

## Steps

1. **Pick the version.** Read the commits since the last `v*` tag (`git log --oneline <tag>..main`,
   or all of `main` when there is no tag). Suggest `patch`, `minor`, or `major`: breaking changes or a
   `SEED_VERSION` bump in `src/db/schema.ts` mean at least `minor` while the version is `0.x`.
2. **Dry run.** Run `npm run release -- <bump> --dry-run`. Fix any failure before going on.
3. **Write the release notes** to a file in the scratchpad: a short summary of what changed for
   users, grouped as features and fixes. Leave out internal-only commits. Don't name the data
   release: the script appends a line naming the data release it checked.
4. **Ask the user to confirm**, showing the version, the commit being released, and the notes. Say
   that this rebuilds and publishes the data release, then pushes to `main`, tags, and publishes the
   plugin release. Do not go on without a clear yes.
5. **Run the release in the background** (it can take two hours):
   `npm run release -- <bump> --notes-file <notes>`. Report the data-release run URL it prints.
6. **Report the outcome**: the release URL, the tag, and the data release it ships with. If it
   failed, quote the error and say which step failed.

## Recovering from a failure

- **Before the data build finishes** (checks, tests, or the workflow run): nothing was published
  except possibly a data release. Fix the problem and run again.
- **After the data build succeeded** but a later step failed: rerun with
  `--data-run <run id>` to reuse that build instead of waiting for a new one. The run must be a
  `data-release` run that built the current `HEAD` of `main`, and its release must still be the newest.
- **After the push** but the GitHub release failed: the tag is already on GitHub. Create the release
  by hand with `gh release create vX.Y.Z --title "brick-art vX.Y.Z" --notes-file <notes> --latest --verify-tag`.

## Notes

- Users install from the default branch, so the push to `main` is what makes the new version
  available. The tag and release mark it and carry the notes.
- The plugin picks the newest data release for its schema version, so it does not pin a data tag.
  The weekly data rebuilds keep reaching installed plugins between releases.
