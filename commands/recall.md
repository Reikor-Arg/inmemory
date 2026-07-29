---
description: Search verbatim history from previous Claude Code sessions
argument-hint: [--global] <query>
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" search $ARGUMENTS
```

Returns **verbatim** excerpts from previous transcripts, ranked by BM25. Without
`--global` it searches only the current project.

Present what is relevant and cite the session and date of each excerpt. If
something contradicts the current state of the code, say so: excerpts are from
when they happened and the code may have changed since. If there are no
results, say that plainly rather than answering from memory.
