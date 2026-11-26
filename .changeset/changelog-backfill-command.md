---
"agent-gates": minor
---

Added the `changelog backfill` command (`agent-gates.changelog-backfill`). It builds a repository's `## Earlier changes` changelog section from its merged pull requests before Changesets adoption, and refuses any result unless that section ends the file as one top-level heading, every other top-level heading and the prefix are kept byte for byte, and a rerun gives the same output.
