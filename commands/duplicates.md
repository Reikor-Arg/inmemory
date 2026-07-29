---
description: Declarations and filenames repeated across the repo
argument-hint: [--refresh]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" duplicates $ARGUMENTS
```

The same name declared in several files, and filenames reused across
directories. Migrations, tests and generated trees are excluded — repetition
there is the framework's convention, not a duplicated concern.

This reports facts, not verdicts. Repetition is not automatically a problem: an
interface implemented several times looks identical to a concern that was
copy-pasted. Read the files before proposing to merge anything, and say which
ones you actually read.
