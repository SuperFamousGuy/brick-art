---
description: Rebuild the brick-art parts database from the latest source data
---

Refresh the brick-art parts database.

1. Run `BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}" node --max-old-space-size=3072 "${CLAUDE_PLUGIN_ROOT}/src/entry/seed.mjs" --refresh` with the Bash tool. Set `run_in_background` to true, because the download takes a few minutes. Keep the `BRICK_ART_DATA` prefix: it makes the seed write to the plugin data folder, which the MCP server reads.
2. Tell the user that the refresh is running in the background.
3. When the command finishes, call the `database_status` tool and report its result to the user. If the command failed, report its error output instead.
