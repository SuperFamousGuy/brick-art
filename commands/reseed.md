---
description: Rebuild the brick-art parts database from the latest source data
---

Refresh the brick-art parts database.

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/brick-art-seed" --refresh` with the Bash tool. Set `run_in_background` to true, because the download takes a few minutes.
2. Tell the user that the refresh is running in the background.
3. When the command finishes, call the `database_status` tool and report its result to the user. If the command failed, report its error output instead.
