---
name: plan
description: Use when the user asks to plan a feature, a refactor, a migration, or any change spanning more than one file — "how would we do X", "plan this", "break this down". Grounds the plan in what the repo already is and what was already decided, instead of proposing from a blank page.
---

# Planning a change

A plan written without reading the code is a guess with headings. Before
proposing anything, spend the cheap calls that tell you what you are planning
*into*. All of these run on the CPU and cost nothing to produce:

```
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs map            # what exists
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs duplicates     # what is already repeated
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs decide --list  # what was already settled
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs search <topic> # what was tried before
```

The last two matter most. Proposing something the team already rejected, for
reasons recorded months ago, is the most common way a plan wastes everyone's
time — and the reason is usually still valid.

## Shape of a good plan

**Phases, each one shippable.** A phase that cannot be merged on its own is not
a phase, it is a step in a phase. If the branch must contain all five to work,
the plan has one phase and you should say so rather than pretend otherwise.

**Every phase names its check.** Not "test it" — the specific thing that fails
if the phase is wrong: a test file, a command with expected output, a page that
should render. A phase without a check is a phase nobody can verify you
finished.

**Order by risk, not by comfort.** The step most likely to invalidate the plan
goes first, while changing course is still cheap. Doing the easy renames first
feels productive and buys nothing.

**Name what you are not doing.** Every plan has a boundary; leaving it implicit
is how scope grows silently. Write the excluded items down.

## Sizing

Estimate in *files touched* and *whether the change is reversible*, never in
hours. "Three files, additive, revert is a git revert" tells the reader
everything they need; "about two days" tells them nothing they can check.

Flag anything irreversible explicitly: schema migrations that drop columns,
data backfills, published API changes, anything with a deploy that cannot be
rolled back. Those deserve their own phase and their own rollback note.

## Before writing it down

Ask yourself whether the plan is warranted at all. A change that touches one
file and has an obvious shape needs a sentence, not a document. Producing a
five-phase plan for a twenty-minute edit is a way of looking busy.

If the request is ambiguous in a way that changes the plan, ask one question
and wait. If it is ambiguous in a way that does not, pick the reasonable
reading, say which one you picked, and continue.

## After it is agreed

Record the decision, not the plan:

```
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs decide "chose X over Y because Z"
```

The plan is a working document and will be wrong in places. The decision —
what was chosen and *why the alternative was rejected* — is what nobody can
reconstruct in six months, and it is the thing that stops the same debate from
happening again.

## Executing it

Work one phase at a time and run its check before moving on. When a phase
turns out to be wrong — which happens — say so, say what you found, and revise
the remaining phases. Do not quietly widen a phase to absorb the surprise: the
plan stops matching reality and nobody notices until the end.

Report what actually happened. If a check fails, show the output. If a phase
was skipped, say which and why. A plan reported as complete when it is not is
worse than no plan, because it removes the reason to look.
