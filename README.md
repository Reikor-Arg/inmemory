# inmemory

Claude Code forgets everything between sessions, and forgets the details within
one every time the context is compacted. This plugin gives it back the exact
words — not a summary of them.

It also stops a single oversized skill from quietly costing you three quarters
of a session.

**No dependencies. No API calls. No model runs. Nothing leaves your machine.**

---

## Install

```
/plugin marketplace add Reikor-Arg/inmemory
/plugin install inmemory
```

Requires Node (any version from 14 on). Claude Code's npm install path already
brings it; if you use the standalone binary, `node --version` should print
something.

That's it. The first session indexes the transcripts Claude Code has already
been writing all along — nothing new is recorded, and nothing is uploaded.

## What it does

**Recall.** When what you type shares uncommon words with a past turn in this
project, you get a few one-line pointers into that history:

```
<recall> ...
  #4121 | 2026-05-14 | session 8259c017 | can we keep the current sync tool or does it need replacing?
  #4145 | 2026-05-14 | session 8259c017 | the scanner should run after the sync, not during
</recall>
```

Claude pulls the full verbatim text only for the ones that matter. A typical
injection costs about 200 tokens. A vague question costs **zero** — if nothing
clearly matches, nothing is injected.

**Skill gate.** Before a skill loads, its size is checked. Small ones pass
untouched. A 794 KB one is declined with a pointer to the specific file worth
reading instead. Nothing becomes unreachable; the expensive path just stops
being the automatic one.

## Commands

| Command | What it gives you |
|---|---|
| `/recall <query>` | verbatim excerpts matching a query (`--global` for every project) |
| `/timeline` | every session, newest first, grouped by ISO week |
| `/digest [YYYY-Www]` | what was asked in a week, verbatim, plus files and commands |
| `/topics` | terms frequent here and rare elsewhere: what this project is about |
| `/map [name]` | the repo's layout and declarations, or which file declares `name` |
| `/duplicates` | the same name declared in several files; filenames reused across directories |
| `/standup` | uncommitted work, branches active recently, how far each is from the default |
| `/decide` | record why something was decided, so the reason outlives the session |

`timeline` and `digest` are the trace: what you worked on, when, in your own
words. They are computed from the index, so they cost **no tokens to produce** —
unlike a memory plugin that runs a model in the background to write summaries.

The same things run directly, from anywhere:

```
node <plugin>/hooks/recall.mjs timeline [--global] [--limit=N]
node <plugin>/hooks/recall.mjs digest [--global] [YYYY-Www]
node <plugin>/hooks/recall.mjs topics [--top=N]
node <plugin>/hooks/recall.mjs map [--refresh] [name]
node <plugin>/hooks/recall.mjs duplicates [--refresh]
node <plugin>/hooks/recall.mjs standup [--days=N]
node <plugin>/hooks/recall.mjs decide "<what and why>" | --list [term]
node <plugin>/hooks/recall.mjs sessions [--global] [filter]   # one line per session
node <plugin>/hooks/recall.mjs show <id>                      # verbatim text of a pointer
node <plugin>/hooks/recall.mjs index --all                    # backfill every project (~25 s)
node <plugin>/hooks/recall.mjs stats
```

## Why not just use a summarising memory plugin

Summarising at write time is lossy and permanent. The detail the summariser
dropped — the exact variable name, the error string, why approach B was
rejected — cannot be recovered, and a summariser that misreads a session stores
that misreading as fact.

This one keeps the original text and summarises nothing. If a chunk comes back,
those words were actually said.

It also costs nothing to write. No second model runs in the background to
produce observations; indexing is plain string work.

## What it deliberately does not do

No background model runs. Reports are computed from the index and handed to
Claude as raw material; Claude writes the narrative when you ask for one, and
only then. Nothing is generated while you are not looking, so nothing is
generated wrong while you are not looking either.

## Decisions

A decision made in turn 47 of a long session is, in practice, lost: findable
only by someone who already remembers enough to search for it. `decide` writes
it to `DECISIONS.md` in the repo — dated, branch-tagged, append-only.

In the repo rather than in the index on purpose. A decision is something the
team should see in a diff and be able to argue with, not a private note on one
machine. The index picks the file up like any other, so it is searchable too.

## Known limitation

Retrieval is lexical. If you ask about "network errors" and the session said
"socket timeout", with no word in common, it will not find it — and it will
tell you nothing rather than guess. Query expansion was implemented, measured,
and removed: it dragged in unrelated results, and a wrong hit costs tokens and
sends work down the wrong path. A false negative is honest and free.

## Tuning

All optional, via environment variables:

| Variable | Default | Effect |
|---|---|---|
| `RECALL_BUDGET_TOKENS` | 400 | ceiling on one automatic injection |
| `RECALL_MIN_COVERAGE` | 0.5 | share of query terms a chunk must contain |
| `RECALL_MAX_HITS` | 4 | pointers per injection |
| `SKILL_WEIGHT_LIMIT` | 120000 | bytes above which a skill is declined |
| `SKILL_WEIGHT_ALLOW` | — | comma-separated skills to always allow |

## Where your data lives

`~/.claude/recall/` — an index built from the transcripts already in
`~/.claude/projects/`. Delete the folder to reset; it rebuilds on the next
session. Nothing is sent anywhere.

## Failure behaviour

Every hook fails open. A broken index, an unreadable file, a malformed payload:
the turn proceeds as if the plugin were not installed. It can lose the ability
to help; it cannot block your work.

## License

MIT
