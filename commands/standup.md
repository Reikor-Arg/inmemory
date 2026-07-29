---
description: What is in flight across branches and worktrees
argument-hint: [--days=N]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" standup $ARGUMENTS
```

Uncommitted changes, branches active in the last N days with how far each is
ahead of and behind the default branch, and any worktrees. Straight from git —
nothing is inferred.

Summarise what is in flight and what looks stalled. A branch far behind the
default is a merge risk worth naming; a branch with no recent commits may simply
be finished. Do not guess which — say what the numbers show.
