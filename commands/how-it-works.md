---
description: What inmemory does, what it costs, and what it cannot do
---

Explain the plugin to the user in plain language. Adapt to what they ask — if
they only want to know why something was injected, answer that and stop.

Show them the real state of their own install rather than describing it in the
abstract:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" stats
```

## The problem it solves

Claude Code forgets the project between sessions, and forgets details within one
every time the context is compacted. So the same decision gets explained twice,
and an approach already rejected gets proposed again — the turn where it was
rejected is simply gone.

## How it works

Claude Code already writes a full transcript of every session to
`~/.claude/projects/`. This indexes those transcripts and puts the relevant
pieces back in front of the model at the moments they matter.

Nothing is summarised. The index stores the original text, so what comes back is
what was actually said. That is the whole design: a summariser that misreads a
session stores the misreading as fact, and replays it months later as something
the user said. This can fail to find something; it cannot invent it.

Five hooks, all automatic:

- **session start** — where the project left off (~110 tokens)
- **each prompt** — pointers into past turns sharing uncommon words (~200)
- **reading or editing a file** — earlier turns about that file (~150)
- **invoking a skill** — oversized ones declined, with a pointer to the file worth reading
- **turn end** — the new turn is indexed

Each injects **nothing** when it has nothing worth saying. A vague question
costs zero.

## What it costs

Nothing to write: indexing is string work, no model runs. Reading costs only the
few hundred tokens actually injected. The commands (`/timeline`, `/map`,
`/digest`, `/topics`, `/duplicates`, `/standup`) are computed, not generated.

## What it cannot do

Say these plainly if the user's question touches them — an overstated tool gets
trusted where it should not be:

- **Retrieval is lexical.** Different words for the same thing, with nothing in
  common, will not match. It returns nothing rather than guessing.
- **It only knows what was written down.** Reasoning in a thinking block, and
  work done outside Claude Code, are not there.
- **`map` is shallow.** A missing symbol is a gap in the map, not proof it does
  not exist.
- **`digest` shows what was asked, not whether it worked.**

## If something seems wrong

Every hook fails open: a broken index or unreadable file means the turn proceeds
as if the plugin were not installed. So "nothing was injected" is never an error
state — it means nothing cleared the bar, which is the intended behaviour most
of the time.

To check the index is actually populated, run `stats`. To rebuild from scratch:
delete `~/.claude/recall/` and run `index --all`.
