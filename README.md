# inmemory

Claude Code forgets your project between sessions. Within a long one, it forgets
the details every time the context is compacted.

You have felt this. You explain a decision, work for two hours, come back
tomorrow, and explain the same decision again. Or mid-session it starts
proposing the approach you already rejected — because the turn where you
rejected it is gone.

This gives the memory back. Not a summary of what happened: **the exact words**.

**No dependencies. No API calls. No model runs in the background. Nothing leaves
your machine.**

---

## Install

```
/plugin marketplace add Reikor-Arg/inmemory
/plugin install inmemory
```

Needs Node — any version from 14 on. Nothing to configure.

The first session indexes the transcripts Claude Code has been writing all
along. Nothing new is recorded. Nothing is uploaded.

## It works on its own

You never invoke anything. Five hooks do the work:

| When | What arrives | Cost |
|---|---|---|
| You open a project | where it left off: recent sessions, files touched, decisions recorded | ~110 tokens |
| You type a prompt | pointers into past turns that share uncommon words with it | ~200 tokens |
| A file is opened or edited | earlier turns that discussed **that file** | ~150 tokens |
| A skill is invoked | oversized ones are declined, with a pointer to the file worth reading | 0 |
| The turn ends | the new turn is indexed | 0 |

**Each one injects nothing when it has nothing worth saying.** A vague question
costs zero. A file nobody has discussed costs zero. That is the difference
between memory that helps and memory that is just a tax.

## What it looks like

You ask about something you worked on weeks ago:

```
<recall>
  #4121 | 2026-05-14 | session 8259c017 | can we keep the current sync tool or does it need replacing?
  #4145 | 2026-05-14 | session 8259c017 | the scanner should run after the sync, not during
</recall>
```

Two lines, not two pages. Claude pulls the full verbatim text only for the ones
that turn out to matter — and what comes back is what was actually said, word
for word, because nothing was ever summarised.

## Why verbatim matters

Most memory tools run a model over your session and store its summary. That is
lossy in one direction only: the detail the summariser dropped — the exact
variable name, the error string, *why* approach B was rejected — is gone for
good. And a summariser that misreads a session stores the misreading as fact,
where it will be replayed to you confidently, months later, as something you
said.

This stores the original text and summarises nothing. If a chunk comes back,
those words were said. It can fail to find something; it cannot invent it.

That also makes it free to write. There is no second model running in the
background to produce observations — indexing is plain string work. Ten thousand
turns index in about 25 seconds and cost nothing.

## Commands, for digging on purpose

| Command | What it gives you |
|---|---|
| `/recall <query>` | verbatim excerpts matching a query (`--global` across all projects) |
| `/timeline` | every session, newest first, grouped by week |
| `/digest [YYYY-Www]` | what was asked in a week, verbatim, plus files and commands |
| `/topics` | terms frequent here and rare elsewhere: what this project is about |
| `/map [name]` | the repo's layout and declarations, or which file declares `name` |
| `/duplicates` | the same name declared in several files |
| `/standup` | uncommitted work, active branches, how far each is from the default |
| `/decide <what and why>` | record a decision so the reason outlives the session |
| `/how-it-works` | what the plugin does, what it costs, what it cannot do |

All computed from the index. None of them run a model, so none of them cost
tokens to produce — only the output you actually read.

## Decisions

A decision made in turn 47 of a long session is lost in practice: findable only
by someone who already remembers enough to search for it. It is also the thing
nobody can reconstruct later — the choice survives in the code, the *reason*
does not.

`/decide "chose Postgres over SQLite because two services write concurrently"`
appends to `DECISIONS.md` in the repo: dated, branch-tagged, append-only. In the
repo rather than in a private index, because a decision is something the team
should see in a diff and be able to argue with.

Superseding one means adding an entry that says so. Never editing the old one —
that erases the reason someone once chose differently, which is exactly what the
next person needs.

## Skills

Four, which fire on their own when the situation matches:

- **inmemory** — reach for the index instead of re-exploring; how to read its
  output without overstating it
- **plan** — planning a change that spans files, grounded in what the repo is
  and what was already decided
- **design** — building or reviewing UI, starting from the conventions already
  in the project
- **pr** — reviewing, preparing, or waiting on a pull request

What separates these from the same advice anywhere else is the first thing each
does: read what this project already decided. Generic advice cannot notice that
a plan proposes what the team rejected six months ago, that a component ignores
the file beside it, or that a PR quietly reverses a recorded decision. Those are
the failures that cost real time.

## The skill gate

Invoking a skill inlines its text into the prompt and keeps it there for the
rest of the session. Most are a few KB. Some are enormous — one measured 794 KB,
which arrived as a single 325,000-token cache write and raised the cost of every
remaining turn in that session.

Before a skill loads, its size is checked. Small ones pass untouched. Oversized
ones are declined with a pointer to the specific file worth reading instead.
Nothing becomes unreachable; the expensive path just stops being automatic.

## Honest limits

**Retrieval is lexical.** Ask about "network errors" when the session said
"socket timeout", with no word in common, and it will not find it. Query
expansion was built, measured, and removed: it dragged in unrelated results, and
a wrong hit costs tokens *and* sends work down the wrong path. A miss is honest
and free.

**It only knows what was written down.** Reasoning that stayed in a thinking
block, and work done outside Claude Code, are not there.

**`map` is regex-based and shallow.** A missing symbol is a gap in the map, not
proof the symbol does not exist.

**`digest` records what was asked and touched, not whether it worked.** Nothing
tracks whether a fix succeeded.

## Your data

`~/.claude/recall/` — an index built from the transcripts already in
`~/.claude/projects/`. Delete the folder to reset; it rebuilds on the next
session. Nothing is sent anywhere, ever.

## When something breaks

Every hook fails open. A broken index, an unreadable file, a malformed payload:
the turn proceeds exactly as if the plugin were not installed. It can lose the
ability to help. It cannot block your work.

## Tuning

| Variable | Default | Effect |
|---|---|---|
| `RECALL_BUDGET_TOKENS` | 400 | ceiling on one automatic injection |
| `RECALL_MIN_COVERAGE` | 0.5 | share of query terms a chunk must contain |
| `RECALL_MAX_HITS` | 4 | pointers per injection |
| `SKILL_WEIGHT_LIMIT` | 120000 | bytes above which a skill is declined |
| `SKILL_WEIGHT_ALLOW` | — | comma-separated skills to always allow |

## License

MIT
