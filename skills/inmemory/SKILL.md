---
name: inmemory
description: Use when starting work in a project you have not seen this session, when the user refers to past work ("what did we decide", "how did we do X", "last week"), before a refactor that spans files, or when picking up branches mid-flight. Turns the inmemory index into answers instead of re-exploring from scratch.
---

# Using the inmemory index

Every command below runs on the CPU and returns text. None of them invoke a
model, so none of them cost tokens to produce — only the output you actually
read costs anything. Prefer them over re-deriving the same information with a
dozen Glob, Grep and Read calls.

Run them with Bash. `$P` below is `${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs`.

## Pick by what you are missing

| You need | Run |
|---|---|
| The layout of a project you just opened | `node $P map` |
| Where something is declared | `node $P map <name>` |
| What this project is about | `node $P topics` |
| What was worked on, and when | `node $P timeline` |
| What happened in a specific week | `node $P digest 2026-W28` |
| The exact words of a past decision | `node $P search <terms>` then `node $P show <id>` |
| Repeated declarations before a refactor | `node $P duplicates` |
| What is in flight across branches | `node $P standup` |
| Why something was decided | `node $P decide --list [term]` |

## Cold start

Opening a project you have not seen this session, in this order:

1. `map` — the shape of the code.
2. `topics` — what this project is about, in its own vocabulary.
3. `timeline --limit=10` — what has been happening lately.

Three commands, no tokens spent producing them, and you are oriented. Do not
start with Glob and Grep: they answer narrower questions more expensively, and
they cannot tell you what the project has historically been *about*.

## When the user refers to the past

"What did we decide about X", "how did we fix Y last time", "we talked about
this" — search before answering. Answering from memory when the transcript is
one command away is how a wrong recollection becomes a wrong decision.

`search` returns pointers; `show <id>` returns the verbatim turn. Quote it and
cite the date. Then say plainly whether the code still matches: excerpts are
from when they happened, and the repository has moved since.

If the search returns nothing, say so. Do not fill the gap with a plausible
reconstruction — a fabricated memory is worse than an admitted blank, because
the user cannot tell the difference.

## Chain searches — you are the judgement between hops

One search is rarely the whole answer. Chain them, with you deciding each hop:

1. `search <your best terms>` — read the pointers, ~200 tokens.
2. Wrong vocabulary? The pointers show the words that were *actually used* —
   yours may not match the session's. Re-search with those. `topics` also
   hands you the project's own vocabulary for exactly this.
3. `show <id>` — only for the pointers that turned out to matter.
4. A hit mid-thread? `show` its neighbours (`show 4102 4103 4104`) — ids are
   assigned in reading order, so adjacent ids are usually adjacent turns.

Each hop costs pointers, not raw log dumps: chaining through the index is the
cheap version of chaining greps over the transcript files, because ranking and
dedup happen outside the context window.

Do not automate the loop blindly. Mechanical re-search with terms from the
results was built into this plugin once, measured, and removed — without
judgement between hops, the first hop's noise becomes the second hop's query.
The judgement is your contribution; make each next query a decision, not a
reflex.

## Recording decisions

When a real alternative is rejected, or the obvious choice is deliberately not
taken, record it: `node $P decide "chose X over Y because Z"`. Include the
reason -- the choice alone is worthless in six months, the reason is the part
nobody can reconstruct.

Do not record every step. A DECISIONS.md full of trivia is as unread as an
empty one. And do not polish the user's words into something they did not say.

## Reading the output honestly

**`duplicates` reports facts, not verdicts.** The same name in several files can
be an interface implemented repeatedly or a concern copy-pasted; the output
looks identical either way. Read the files before proposing to merge anything,
and name which ones you actually read.

**`map` is regex-based and shallow.** A missing symbol is a gap in the map, not
proof the symbol does not exist. Fall back to Grep and say you did.

**`digest` and `timeline` describe what was asked and touched, not what worked.**
Nothing records whether a fix succeeded. Do not narrate outcomes the material
does not contain.

**`topics` is a word list, not a summary.** The terms are entry points to feed
back into `search`, not conclusions about the project.

**Everything is as fresh as the last index run.** The `Stop` hook indexes after
each turn, so the current session is covered; `map` is cached until
`--refresh`. If a result looks stale, refresh before reasoning about it.

## Updating it

If the session-start notice says a newer version exists, you can apply it
yourself — no need to hand it back to the user:

```
claude plugin update inmemory@inmemory
```

The full `plugin@marketplace` id is required; plain `inmemory` returns "not
found". Tell the user a restart is needed for it to take effect.

## What this does not do

It does not remember what was never written down. Reasoning that stayed in a
thinking block, and work done outside Claude Code, are not in the index. If the
answer is not there, that is a real absence, not a retrieval failure to work
around.
