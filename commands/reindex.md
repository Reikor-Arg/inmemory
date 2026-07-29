---
description: Index the history of every project (one-time backfill)
argument-hint:
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" index --all
```

Reads every transcript in `~/.claude/projects/` and indexes what is new. About
25 seconds for a large history; incremental afterwards, so re-running it is
cheap and safe.

Only needed once, to make older projects searchable immediately. Without it each
project is indexed the first time you open it, which also works — this just does
them all at once.

Also the fix when `/doctor` reports an empty index.
