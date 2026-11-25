---
"agent-gates": minor
---

Added the `history scan` command (`agent-gates.history-scan`) to scan every commit in a `<base>..<head>` range (messages, added or renamed paths, and added diff lines including merge conflict resolutions) and optional pull request text through the GitHub CLI against an external private pattern list, refusing without echoing matched text or patterns.
