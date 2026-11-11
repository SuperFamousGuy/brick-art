---
description: Reinstall the brick-art parts database from the latest published release, or rebuild it locally with --local
argument-hint: "[--local]"
---

Refresh the brick-art parts database. The arguments are: `$ARGUMENTS`.

1. Run one of these commands with the Bash tool. Set `run_in_background` to true, because it takes a few minutes. Keep the `BRICK_ART_DATA` prefix: it makes the command write to the plugin data folder, which the MCP server reads. `--variant-from-options` picks the standard or full database from the saved plugin options.
   - With no arguments, download the latest published release again:
     `BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}" node --max-old-space-size=3072 "${CLAUDE_PLUGIN_ROOT}/src/entry/update.mjs" --variant-from-options --force`
   - With `--local`, rebuild the database on this computer from the source data:
     `BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}" node --max-old-space-size=3072 "${CLAUDE_PLUGIN_ROOT}/src/entry/seed.mjs" --refresh --variant-from-options`
2. Tell the user that the refresh is running in the background.
3. When the command finishes, call the `database_status` tool and report its result to the user. If the command failed, report its error output instead.
