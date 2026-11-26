---
"agent-gates": patch
---

Require `move check` Markdown link resolution to verify that each intermediate path segment exists as a folder (or a tracked symlink that resolves to one) in the destination tree before traversing further segments or `..`. Links through missing folders or regular files now decline with `DOMAIN_MOVE_REFERENCE_DANGLING`.
