---
"agent-gates": patch
---

Add a post-check to `changelog earlier` that refuses any result unless it ends with a single top-level `## Earlier changes` heading, preserves all other top-level headings and the prefix byte for byte, and repeats identically.
