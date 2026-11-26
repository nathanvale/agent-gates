---
"agent-gates": patch
---

Make `move check` compare each moved file's git mode as well as its blob hash. A file that keeps its bytes but loses its executable bit (`100755` to `100644`), or a tracked symlink that arrives as a regular file (`120000` to `100644`), now declines with `DOMAIN_MOVE_FILE_CHANGED`. The refusal names the path, both modes and both hashes, and the repair says to restore the source mode.
