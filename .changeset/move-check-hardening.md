---
"agent-gates": patch
---

Hardened `move check` so test discovery exports the full git tree instead of skipping `export-ignore` paths, Markdown link checks cover `.md`, `.markdown`, `.mdown`, and `.mkd` and follow tracked symlinks inside the tree, empty `--source-folder` or `--destination-folder` selections and truncated `ls-tree` listings decline with `DOMAIN_PRECONDITION_UNMET`, `ls-tree` uses `--full-tree` for subfolder invocations, compound destination test scripts are reported under not checked, and git calls strip inherited `GIT_*` environment overrides.
