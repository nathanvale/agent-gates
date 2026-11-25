# agent-gates glossary

This file is the source of truth for the words this repository owns.

## Language

**Changeset**:
One Markdown file under `.changeset/` or `.changeset/pre/`, written by the upstream Changesets CLI, that records one change and its semver bump.
_Avoid_: change note (the removed JSON engine's file)

**Gated path**:
A tracked path under `src/` at any depth, dot-files included, or `package.json`. A branch that adds, removes, renames or edits one needs a changeset.
_Avoid_: shipped path

**Earlier changes**:
The final `## Earlier changes` section of `CHANGELOG.md`, listing pull requests merged before a repository adopted Changesets in merge order.

**Move**:
Files carried from a source tree (repository, commit, folder) to a destination tree, by copy, import or merge.
_Avoid_: the act of moving; a Move is the record of what was carried
