---
description: What happened in a given week, verbatim
argument-hint: [--global] [YYYY-Www]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" digest $ARGUMENTS
```

Without a week, it uses the most recent one. Output is raw material, not prose:
the verbatim first line of each turn, the files touched ranked by how many
sessions touched them, and the commands run.

Write the narrative yourself from that material. Quote the user's own words when
describing what was asked. Do not assert outcomes the material does not show —
it records what was asked and touched, not whether it worked.
