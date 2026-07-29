---
description: Recurring themes distinctive to this project
argument-hint: [--top=N]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" topics $ARGUMENTS
```

Terms frequent in this project and rare across the others. Raw frequency alone
returns filler ("error", "true", "command"); the contrast against the rest of
the corpus is what makes a term a subject. Per-project by construction.

Use them as entry points: each one can be fed straight into `recall` to pull the
verbatim turns behind it.
