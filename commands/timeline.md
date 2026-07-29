---
description: Chronological history of this project's sessions, grouped by week
argument-hint: [--global] [--limit=N]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" timeline $ARGUMENTS
```

Every session, newest first, grouped by ISO week with turn and file counts.
Nothing here was written by a model: the one-line description of each session is
the user's own first message, verbatim.

Summarise the arc for the user. If a week is missing or a session shows only an
`init` command, say so rather than inventing what happened.
