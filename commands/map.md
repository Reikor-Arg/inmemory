---
description: Structure of the current repo — files and declarations, no model involved
argument-hint: [--refresh] [name]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" map $ARGUMENTS
```

With no argument: the layout of the project, directory by directory, with the
declarations found in each file. With a name: which file declares it.

The map is cached per project and rebuilt with `--refresh`. It is regex-based
and shallow on purpose — a map, not a parser. Treat a missing symbol as a gap in
the map, not proof it does not exist; fall back to Grep.

Use this before exploring a project you have not seen this session. It replaces
several Glob and Grep round trips with one, and it costs no tokens to produce.
