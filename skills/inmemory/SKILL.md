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

## What this does not do

It does not remember what was never written down. Reasoning that stayed in a
thinking block, and work done outside Claude Code, are not in the index. If the
answer is not there, that is a real absence, not a retrieval failure to work
around.
