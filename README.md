# inmemory

[![test](https://github.com/Reikor-Arg/inmemory/actions/workflows/test.yml/badge.svg)](https://github.com/Reikor-Arg/inmemory/actions/workflows/test.yml)

Claude Code forgets. Between sessions, and inside a long one every time the
context is compacted.

This gives the memory back as **the exact words**, not a summary of them. It
reads the transcripts Claude Code already writes, so nothing new is recorded and
nothing leaves your machine. No dependencies, no API calls, no model in the
background.

## Install

Needs Node 18+. Inside Claude Code:

```
/plugin marketplace add Reikor-Arg/inmemory
/plugin install inmemory
```

**Restart Claude Code** — hooks load at startup. Then `/reindex` once to make
your existing history searchable, and `/doctor` to check the install.

## What it does on its own

You never invoke anything.

| When | What arrives | Cost |
|---|---|---|
| The context is compacted | your own turns from this session, in order | ~700 tok |
| You open a project | where you left off | ~110 tok |
| Every session start | routing rules: what belongs on a cheaper model | ~255 tok |
| You type a prompt | pointers into past turns sharing uncommon words with it | ~200 tok |
| A file is opened | earlier turns that discussed that file | ~150 tok |
| A file is re-read, unchanged | the read is declined — that copy is still in context | saves it |
| An oversized skill is invoked | declined, with a pointer to the file worth reading | saves it |
| A turn ends | it gets indexed | 0 |

**Nothing is injected when nothing matches.** A vague question costs zero.

## Compaction

A real one, from the record Claude Code writes itself:

```
preTokens:   985,335    what the conversation held
postTokens:   19,066    what survived
```

The rest became a paraphrase. But the transcript on disk is untouched —
compaction rewrites context, never the record. So at the boundary this reads it
and hands back what you actually asked for, in your words, in order, for about
700 tokens.

It arrives **at the boundary, not on your next prompt**: right after a
compaction the problem is that you no longer know what to ask for.

## Honest limits

Retrieval is lexical. Measured over 60 real questions, counting a hit only when
it returned the right project *and* the right moment:

| How the question was worded | Found it |
|---|---|
| The words actually used at the time | 90.0% |
| Reworded, little vocabulary in common | 20.0% |

**The 20% is the real limit, not the 90.** Ask about "network errors" when the
session said "socket timeout" and it will not find it. Query expansion was built
to close that, measured, and removed: it added wrong hits, and a wrong hit costs
tokens *and* sends work down the wrong path.

One machine, one corpus, one user — a shape, not a benchmark.

**A transcript is full of things that were true for twenty minutes.** There is no
recency weighting in the ranking — it is BM25, ordered by score alone — so a turn
you later retracted can come back as readily as the one that replaced it. Worse:
BM25 rewards rare terms, and the variable name from an abandoned approach is
often rarer than the one that survived, so the retracted turn can outrank it.

This is the failure mode to know about, because it is the inverse of the usual
one. A summary at least *saw* the retraction. Verbatim text did not, and it reads
as more trustworthy precisely because it is literally what was said.

What is done about it: for every hit, the search also returns the latest *other*
turn from that same session which matches the query, marked `NEWER`. A change
of mind lives where it happened — same session, further on — so that is where it
looks. Every hit also carries its timestamp to the minute, so two contradicting
turns can be ordered by eye.

That is deliberately not recency weighting. Weighting needs a constant nobody can
guess, and too much of it breaks finding something from three weeks ago, which is
half the value here. This adds context instead of second-guessing the score.

A later turn on the same subject is not the same thing as a retraction, though, and
lexical matching cannot tell them apart. So with `INMEMORY_ADJUDICATE=1` and Ollama
running, `/recall` asks the local model whether that later turn actually reversed
the earlier one, and marks it `SUPERSEDED` only when it did. Off by default; needs
Ollama, with no cloud fallback; about 1.4 s on a warm 8B model, and never on the
automatic injection.

**That adds judgement, not reach.** It only ever sees pairs the lexical layer
already surfaced, so it does nothing for a retraction that shares no words with
your query, or one made in a different session. Those remain invisible.

So, with everything on: treat a hit as *something that was said then*, never as
*what is true now*.

It also only knows what was written down, and an empty index has nothing to say,
so the first week of a fresh install is quieter than the fourth.

## Commands

| Command | What it gives you |
|---|---|
| `/recall <query>` | verbatim excerpts (`--global` across all projects) |
| `/timeline` · `/digest` | sessions by week; what was asked in one, verbatim |
| `/topics` · `/map` · `/duplicates` | what this project is about; its layout; repeated names |
| `/standup` | uncommitted work, branches, distance from default |
| `/decide <what and why>` | append a decision to `DECISIONS.md` in the repo |
| `/doctor` · `/lint` · `/reindex` | check the install; audit prompts; backfill history |
| `/how-it-works` | what it does, what it costs, what it cannot do |

None of them run a model. They are not free to *have*, though:
`claude plugin details inmemory` reports **~607 tokens always-on** — every
command and skill leaves its description in the prompt. Hooks cost nothing; they
run outside the model.

## Config

| Variable | Default | Effect |
|---|---|---|
| `RECALL_BUDGET_TOKENS` | 400 | ceiling on one automatic injection |
| `RECALL_MIN_COVERAGE` | 0.5 | share of query terms a chunk must contain |
| `RECALL_MAX_HITS` | 4 | pointers per injection |
| `INMEMORY_BLOCK_REREADS` | 1 | `0` allows re-reading an unchanged file |
| `INMEMORY_RULES` | 1 | `0` stops injecting the routing rules |
| `INMEMORY_UPDATE_CHECK` | 1 | `0` stops the daily new-release check |
| `OLLAMA_HOST` | 127.0.0.1:11434 | where to look for a local model |
| `INMEMORY_ADJUDICATE` | 0 | `1` lets a local model judge supersession on `/recall` |
| `SKILL_WEIGHT_LIMIT` | 120000 | bytes above which a skill is declined |

Edit the routing rules in `ground_rules.md` — everything after the last `---` in
that file is what gets injected.

## When it seems broken

Every hook fails open: a broken index or an unreadable file lets the turn
proceed exactly as if the plugin were not installed. So silence is not evidence
of a bug — it is usually correct.

- **Nothing is injected.** Usually nothing matched. Check `/doctor`, then try
  `/recall <a distinctive phrase you know you used>`.
- **Commands not found.** Not loaded. Restart, then check `/plugin`.
- **It worked, then stopped.** Almost always node: a version manager switched
  versions, or the hook's shell has a different PATH.

Anything else: [open an issue](https://github.com/Reikor-Arg/inmemory/issues).
The form asks for `/doctor` output first, because it separates those cases in one
line.

## Updating and removing

```
/plugin marketplace update inmemory     # then restart
/plugin uninstall inmemory              # rm -rf ~/.claude/recall for the disk
```

Once a day at session start it checks for a newer release and adds one line if
there is one. It notifies; it does not install itself. Your transcripts in
`~/.claude/projects/` are Claude Code's own and are never touched.

---

Design notes, measurements, and why several obvious things were rejected:
[docs/DESIGN.md](docs/DESIGN.md). Release history: [CHANGELOG.md](CHANGELOG.md).
MIT.
