---
description: Check the inmemory install and report anything wrong
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" doctor
```

Checks Node version, index size, transcripts found, whether this directory maps
to a known project, write permissions, and search latency.

`FIX` lines are real problems and each says what to do. `NOTE` lines are
expected states, not failures — an empty project or a directory outside git is
normal. Report them as such rather than alarming the user.

If everything passes and context still is not arriving, the hooks are probably
not loaded: Claude Code reads them at startup, so a restart is the first thing
to try.
