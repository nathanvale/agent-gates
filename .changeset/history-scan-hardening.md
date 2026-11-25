---
"agent-gates": patch
---

Hardened `history scan` against repository and host settings: pinned `log.showRoot=true` for unrelated-history root commits, forced `--encoding=UTF-8` when reading commit messages, resolved both range ends once to full commit hashes for all three git reads, and passed `--hostname <host>` from the origin remote to every `gh api` call.
