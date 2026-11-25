---
"agent-gates": minor
---

Added the `move check` command (`agent-gates.move-check`) to verify that a move between repositories dropped no files, changed no blob hashes, left no dangling path references or broken relative Markdown links, kept no moved blobs in the source, and dropped no discovered test files.
