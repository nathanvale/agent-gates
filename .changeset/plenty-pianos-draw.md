---
"agent-gates": patch
---

Moved the agent-cli-kernel pin from 426e5dbd to 1f871cfd. At the new pin, the kernel's diagnostics log lives at `<state>/my-agent-dojo/<cli>/diagnostics`, where `<state>` is `$XDG_STATE_HOME` or `~/.local/state`. The kernel does not move logs from the old location. agent-gates selects no kernel add-on, so it writes no diagnostics log, and its commands behave as before.
