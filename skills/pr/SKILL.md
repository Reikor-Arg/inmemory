---
name: pr
description: Use when reviewing a pull request, preparing one, or waiting on CI and review comments — "review this PR", "is it ready to merge", "why is CI failing", "watch this until it lands". Reviews the diff against what the project already decided, not against generic best practice.
---

# Pull requests

## Reviewing

Read the diff, then read enough of the surrounding files to know what the diff
*changes*. A review based only on the patch catches typos and misses the two
things that actually matter: whether the change is correct in context, and
whether it contradicts something already settled.

```
gh pr diff <n>                                                # the change
gh pr view <n> --json title,body,files,reviews,statusCheckRollup
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs decide --list      # what was already settled
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs search <topic>     # how this was handled before
```

A PR that quietly reverses a recorded decision is the most expensive thing to
miss, because it looks correct in isolation and only breaks the thing the
decision was protecting.

### What to look for, in order

1. **Does it do what the description says** — and only that. Unrelated changes
   riding along are how regressions arrive unreviewed.
2. **Every caller of every changed signature.** Grep them; do not assume the
   author did. This is where real breakage hides.
3. **The error paths.** Happy path is usually right. What happens on timeout,
   empty input, a second concurrent call, a partial write?
4. **Data and migrations.** Anything that drops, backfills, or reshapes stored
   data deserves its own scrutiny and a stated rollback.
5. **Secrets and input at trust boundaries.** A key in a diff is a stop-everything
   finding, and it stays in the history after the fix.
6. **Tests that would fail if the change were wrong.** A test that passes against
   both the old and new behaviour tests nothing.

### How to write the review

Lead with whether it can merge. The author wants that answer first, not last.

Separate blocking from optional, explicitly. An unlabelled pile of comments
makes the author guess, and they will guess wrong in whichever direction costs
more.

Quote file and line. State the failure concretely: the input, and what goes
wrong with it. "This could break" is not reviewable; "with `items = []` this
divides by zero on line 40" is.

Say what you did not check. Nobody reviews a 900-line diff thoroughly, and
pretending otherwise gives false assurance to everyone downstream.

## Preparing one

Title says what changed, body says **why** — the diff already shows what. Link
the issue. Call out anything irreversible, and anything you want the reviewer to
look at hardest.

Small PRs get real reviews; large ones get approvals. If it exceeds roughly 400
lines of real change, look for a split before asking anyone to read it.

## Watching one until it lands

```
gh pr checks <n> --watch
gh pr view <n> --json reviews,comments,mergeStateStatus
```

When CI fails, read the actual log before theorising — `gh run view <id> --log-failed`.
A flaky test and a real failure look identical from the summary line, and
guessing wrong costs a rerun and the reviewer's patience.

When review comments land, address them in the code and reply to each one saying
what you changed. A silent force-push leaves the reviewer re-reading the whole
diff to find out whether you agreed with them.

Do not merge on the user's behalf unless asked. Report that it is mergeable and
let them decide — merging is theirs, and it is not reversible in the way a
comment is.
