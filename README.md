# inmemory

[![test](https://github.com/Reikor-Arg/inmemory/actions/workflows/test.yml/badge.svg)](https://github.com/Reikor-Arg/inmemory/actions/workflows/test.yml)

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

**1. Check you have Node** (18 or newer):

```
node --version
```

If that prints nothing, install it from [nodejs.org](https://nodejs.org) — the
LTS build is fine. Nothing else is needed: no npm install, no build step, no
API key.

**2. Add and install, inside Claude Code:**

```
/plugin marketplace add Reikor-Arg/inmemory
/plugin install inmemory
```

**3. Restart Claude Code.** Hooks are read at startup, so nothing happens until
you do.

**4. Index the history you already have** (optional, about 25 seconds):

```
/reindex
```

Without this, history is indexed project by project as you open each one, which
also works — the backfill just makes everything searchable immediately.

### Check it worked

```
/doctor
```

It reports Node version, how many turns are indexed, whether the index is
writable, and search latency. `FIX` lines are real problems and each says what
to do; `NOTE` lines are expected states, not failures.

The clearest sign it is running: open a project you have used before, and the
first thing in the session is a short block saying where you left off.

### Manual install

If `/plugin marketplace add` is not available in your version:

```
git clone https://github.com/Reikor-Arg/inmemory ~/.claude/inmemory
```

Then add to `~/.claude/settings.json`, replacing `<HOME>` with your home path:

```json
"hooks": {
  "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [
    { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh recall.mjs session-start", "timeout": 15 }]}],
  "UserPromptSubmit": [{ "hooks": [
    { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh recall.mjs inject", "timeout": 15 }]}],
  "Stop": [{ "hooks": [
    { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh recall.mjs hook-index", "timeout": 30 }]}],
  "PreCompact": [{ "hooks": [
    { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh recall.mjs hook-index", "timeout": 30 }]}],
  "PreToolUse": [
    { "matcher": "Skill", "hooks": [
      { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh skill-gate.mjs", "timeout": 10 }]},
    { "matcher": "Read|Edit|Write|NotebookEdit", "hooks": [
      { "type": "command", "command": "sh <HOME>/.claude/inmemory/hooks/run.sh recall.mjs file-context", "timeout": 10 }]}
  ]
}
```

`run.sh` is a launcher, not a wrapper with opinions: it finds node and execs it.
That indirection exists because on macOS and Linux a hook does not run in a login
shell, so a node installed by nvm, fnm, volta or asdf is on PATH for you and
invisible to the hook. It checks the usual install locations and, last, asks your
login shell — and if it finds nothing it exits quietly, which is the same as not
having the plugin. On Windows the hooks call `node` directly.

Slash commands and skills only come with the plugin install; the hooks above are
what does the automatic work.

The first session indexes the transcripts Claude Code has been writing all
along. Nothing new is recorded. Nothing is uploaded.

## It works on its own

You never invoke anything. Five hooks do the work:

| When | What arrives | Cost |
|---|---|---|
| You open a project | where it left off: recent sessions, files touched, decisions recorded | ~110 tokens |
| **Every session start** | **routing rules: what belongs on the cheap tier** | **~255 tokens** |
| **The context is compacted** | **your own words from this session, in order — the thread that was just summarised away** | **~700 tokens** |
| You type a prompt | pointers into past turns that share uncommon words with it | ~200 tokens |
| A file is opened or edited | earlier turns that discussed **that file** | ~150 tokens |
| **A file is read that was already read, unchanged** | **the read is declined — that copy is still in context** | **saves the whole file** |
| A skill is invoked | oversized ones are declined, with a pointer to the file worth reading | 0 |
| The turn ends | the new turn is indexed | 0 |

**Each one injects nothing when it has nothing worth saying.** A vague question
costs zero. A file nobody has discussed costs zero. That is the difference
between memory that helps and memory that is just a tax.

## Compaction stops being a loss

When the context fills, Claude Code replaces the conversation with a summary.
Here is a real one, from the boundary record Claude Code itself writes:

```
preTokens:   985,335      <- what the conversation held
postTokens:   19,066      <- what survived
durationMs:  129,320      <- 2 min 9 s of summarising
```

966,269 tokens became a paraphrase of themselves. That is where the thread goes:
not deleted, *reworded*, and the wording that goes missing is the specific
one — the variable name, the error string, why approach B was rejected.

The transcript on disk is untouched — compaction rewrites context, never the
record. So the moment it happens, this reads the session's own transcript and
hands back what you actually asked for, in your words, in order:

```
<compacted_session_recall>
This session was compacted (985,335 tokens of context replaced by a summary).
What the user actually asked for, in their own words, in order:
  ok pero para, yo no quiero que alguien tenga que andar tirando slashes...
  si hablamos en porcentaje, cuanto pierde menos el hilo...
  ...
Files touched: recall.mjs, hooks.json, README.md
Recent commands: node hooks/recall.mjs doctor
</compacted_session_recall>
```

About 700 tokens to restore a thread that cost 966,269 to lose. It is
deliberately your words and not a second summary — a summary of a summary is how
the detail disappears in the first place. Anything older is one `search` away,
verbatim.

**It arrives on its own, at the boundary.** Not on your next question, and not
only if your next question happens to match something: the point of failure
after a compaction is that you no longer know what to ask for.

A `PreCompact` hook also flushes the index first, so nothing that happened just
before the boundary is missing afterwards.

Both halves have now run in a real compaction rather than a simulated one — the
figures above are that run.

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
| `/doctor` | check the install and report anything wrong |
| `/lint` | instructions written for older models, and what your prompts cost per turn |
| `/reindex` | one-time backfill of every project's history |

All computed from the index. None of them run a model, so none of them cost
tokens to *produce* — only the output you actually read.

They are not free to have, though. `claude plugin details inmemory` reports the
real figure: **~607 tokens always-on** for the whole plugin — the four skills
plus each command's description sitting in the prompt whether you use them or
not. The hooks themselves cost nothing (they run outside the model).

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

## Work that belongs on a cheaper model

Whatever model you run, it will do work far below its pay grade without
complaining: summarising a long log, drafting a commit message, translating,
rewriting a comment. None of that needs the model you are paying the most for.

So each session starts with a short routing rule — think on the model you are
on, delegate repo work to a tier below if you have one, and send text with no
judgement in it to Haiku. It is written in tiers rather than model names because
plenty of people run Sonnet as their top model and have nothing above it; the
Haiku line is the one that applies to everyone, and it is also the one that
saves the most.

If Ollama is listening on `127.0.0.1:11434`, one more line names the model you
have and says to use it instead — the same work for no tokens at all. Nothing is
injected about it when it is absent, and the check is a refused connection on
localhost.

**This is the only part of the plugin that spends tokens every session whether
it helps or not**: 255, in the cached prefix. One avoided summary pays it back
several times. Edit the rules in `ground_rules.md` — everything after the last
`---` in that file is what gets sent, and nothing in the code depends on the
wording. `INMEMORY_RULES=0` sends nothing.

## The same file, twice

Reading a file puts it in the context window and it stays there. Reading it
again, unchanged, puts a second identical copy beside the first and you pay for
both. A 2,000-line file costs about 25,000 tokens each time.

So before a `Read`, the file's size and modification time are compared against
what this session already read in full. Identical means the copy in context is
still accurate, and the read is declined with a note saying so. Anything that
changes the file — an `Edit`, a `Write`, your own editor — makes the next read
legitimate again, automatically.

Three cases are never blocked, because in each one the premise is false:

- **Partial reads.** A read with `offset`/`limit` put part of the file in
  context, and there is no honest way to know if the part wanted now is the part
  that arrived then.
- **Anything that changed.** Different size or different mtime, and the copy in
  context is stale.
- **After a compaction.** That is the moment the file *leaves* the context, so
  the record is cleared at the boundary.

This is the one saving here that needs no history: it works in the first hour of
a fresh install, with an empty index and nothing indexed yet.

On the corpus it was developed against, re-reads of unchanged files were 22.4%
of everything read from disk. Treat that as evidence the mechanism is worth
having, not as a number that will hold for you — it is one person's habits on
one set of projects. Set `INMEMORY_BLOCK_REREADS=0` to turn it off.

## The skill gate

Invoking a skill inlines its text into the prompt and keeps it there for the
rest of the session. Most are a few KB. Some are enormous — one measured 794 KB,
which arrived as a single 325,000-token cache write and raised the cost of every
remaining turn in that session.

Before a skill loads, its size is checked. Small ones pass untouched. Oversized
ones are declined with a pointer to the specific file worth reading instead.
Nothing becomes unreachable; the expensive path just stops being automatic.

## Honest limits

**Retrieval is lexical, and here is what that costs.** Measured over 60 real
questions across 22 projects, counting a hit only when it returned the right
project *and* the right moment:

| How the question was worded | Found it |
|---|---|
| The words actually used at the time | **90.0%** |
| Same, minus the two rarest words | 88.3% |
| Reworded, 13.6% vocabulary in common | **20.0%** |

That 20% is the real limit, not the 90%. Ask about "network errors" when the
session said "socket timeout", with no word in common, and it will not find it.
Query expansion was built to close exactly this gap, measured, and removed: it
dragged in unrelated results, and a wrong hit costs tokens *and* sends work down
the wrong path. A miss is honest and free.

One machine, one corpus, one user — treat the figures as a shape, not a
benchmark. The rewording test also avoided reusing file and command names on
purpose, which a real person does reuse, so 20% is a floor rather than an
average.

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

[Open an issue.](https://github.com/Reikor-Arg/inmemory/issues) The form asks for
`/doctor` output first, because almost every problem is one of two things — node
is not visible to the hook, or the index is empty — and that one command tells
them apart.

Reports from macOS and Linux are the most useful ones: the plugin was built and
tested on Windows, and the code that finds node on those platforms has never run
outside a test.

Every hook fails open. A broken index, an unreadable file, a malformed payload:
the turn proceeds exactly as if the plugin were not installed. It can lose the
ability to help. It cannot block your work.

That is also why a silent plugin is not evidence of a bug — see below.

### Nothing is being injected

Usually correct behaviour: nothing matched. A vague question, or a subject never
discussed before, injects nothing on purpose. Confirm the index is populated
with `/doctor`, then try `/recall <a distinctive phrase you know you used>`.

If that finds nothing either, the words may simply not match — retrieval is
lexical (see Honest limits).

### `/doctor` says the index is empty

Run the backfill from the install steps. If it stays empty, the index directory
is probably not writable; `/doctor` reports that explicitly.

### Commands are not found

The plugin is not installed or not loaded. Restart Claude Code, then check
`/plugin` lists inmemory as enabled. Hooks configured by hand do the automatic
work but do **not** provide slash commands.

### It worked and then stopped

Almost always a Node change — a version manager switching versions, or a PATH
that a login shell has and the hook shell does not. `node --version` from a
plain terminal is the first check.

## Updating

What changed in each release, and what it was measured against:
[CHANGELOG.md](CHANGELOG.md).

Claude can do it for you — the CLI exists, so asking it to update the plugin
works:

```
claude plugin update inmemory@inmemory
```

Note the full `plugin@marketplace` id: plain `inmemory` returns "not found".
A restart applies it.

At most once a day, when a session starts, it checks GitHub for a newer release
and adds one line if there is one. An HTTPS request and a string compare — no
model runs, so it costs nothing beyond the ~25 tokens of the notice itself, and
only when there is something to say. Set `INMEMORY_UPDATE_CHECK=0` to turn it
off. It fails silently: no network, no notice, no delay beyond a 3-second cap.

To actually update:

```
/plugin marketplace update inmemory
```

**It notifies; it does not install.** Plugins installed through `/plugin` live
in a cache Claude Code manages, so a plugin that updated itself there would be
fighting the platform's own mechanism, and the breakage is hard to trace back.
Beyond that, this is code that runs on every turn — it should not rewrite
itself while nobody is looking.

The index format is stable across versions. If a release ever needs a rebuild,
the notes will say so; deleting `~/.claude/recall/` always forces one safely.

## Uninstalling

```
/plugin uninstall inmemory
```

Then delete the index if you want the disk back:

```
rm -rf ~/.claude/recall
```

Your transcripts in `~/.claude/projects/` are Claude Code's own and are left
untouched. `DECISIONS.md` files stay in your repositories, where they belong.

## Tuning

| Variable | Default | Effect |
|---|---|---|
| `RECALL_BUDGET_TOKENS` | 400 | ceiling on one automatic injection |
| `RECALL_MIN_COVERAGE` | 0.5 | share of query terms a chunk must contain |
| `RECALL_MAX_HITS` | 4 | pointers per injection |
| `INMEMORY_BLOCK_REREADS` | 1 | `0` allows re-reading an unchanged file |
| `INMEMORY_RULES` | 1 | `0` stops injecting the routing rules |
| `OLLAMA_HOST` | 127.0.0.1:11434 | where to look for a local model |
| `SKILL_WEIGHT_LIMIT` | 120000 | bytes above which a skill is declined |
| `SKILL_WEIGHT_ALLOW` | — | comma-separated skills to always allow |

## License

MIT
