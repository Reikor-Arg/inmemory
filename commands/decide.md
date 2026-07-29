---
description: Record a decision so it survives the session, or search past ones
argument-hint: <what was decided and why> | --list [term]
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" decide $ARGUMENTS
```

Appends to `DECISIONS.md` in the repo, dated and tagged with the branch. With
`--list`, prints past decisions; with `--list <term>`, only the matching ones.

Record the decision **and the reason**. "Use Postgres" is worth nothing in six
months; "chose Postgres over SQLite because two services write concurrently" is
the thing nobody can reconstruct later. Use the words that were actually used —
do not polish them into something the person did not say.

Record when a real alternative was rejected, or when the obvious choice was
*not* taken. Not for every step: a file full of trivia is as unreadable as no
file at all.

To supersede a decision, add a new entry saying so. Never edit an old one —
that erases the reason someone once chose differently, which is exactly what a
future reader needs.
