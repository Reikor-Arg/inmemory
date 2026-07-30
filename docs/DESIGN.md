# Design notes

The README says what the plugin does. This says why, and what was measured to
decide it. It exists because several of the choices here look like mistakes until
you know what was tried first.

## Why verbatim, and not a summary

Most memory tools run a model over your session and store its summary. That is
lossy in one direction only: the detail the summariser dropped — the exact
variable name, the error string, *why* approach B was rejected — is gone for
good. And a summariser that misreads a session stores the misreading as fact,
where it will be replayed to you confidently, months later, as something you
said.

This stores the original text and summarises nothing. If a chunk comes back,
those words were said. It can fail to find something; it cannot invent it.

That also makes it free to write. There is no second model producing
observations — indexing is plain string work. Ten thousand turns index in about
25 seconds.

## The retrieval gate is term coverage, not the BM25 score

The obvious design is a score threshold: inject when the best hit scores above
some number. Measured, it does not work. An off-topic query scored **−25.49**
against **−12.44** for a good one — BM25 rewards rare terms, so a query full of
unusual words outscores a relevant query made of ordinary ones. No absolute
threshold separates signal from noise.

So the gate is the share of query terms a chunk actually contains, and BM25 only
orders what passes. Reverting this to a threshold looks cleaner and does the
opposite of what it promises.

A related trap: requiring coverage of *every* term means one extra rare word
raises the bar and kills real hits. Coverage is capped at 3 terms for that
reason.

## Verbatim recall has no idea what was retracted

The sharpest criticism this design has received, and it is correct.

A transcript is full of things that were true for twenty minutes. The ranking is
BM25 ordered by score, with **no recency term at all** — so a turn you later
abandoned comes back exactly as readily as the one that replaced it. And the
mechanism that makes BM25 useful makes this worse: it rewards rare terms, and the
variable name from a discarded approach is often rarer than the one that
survived. The retracted turn can outrank its own replacement.

This is the inverse of the failure mode summaries have. A summary is lossy, but it
*saw* the retraction — it had the whole session in front of it. Verbatim text did
not, and it reads as more authoritative precisely because it is literally what was
said. "This is what you actually wrote" is a strong claim, and it is true about
the sentence while being false about the conclusion.

What exists as a defence is thin and worth stating as thin: every hit carries its
timestamp to the minute, so two contradicting turns can be ordered by eye. That
was a date only until this was pointed out, which could not separate two turns
twenty minutes apart.

What has *not* been done, deliberately for now: recency weighting. Boosting recent
chunks would break the main use case, which is finding the thing from three weeks
ago, and the correct weight is not guessable — it would need measuring against
real retractions, which means first being able to identify them. Doing it by
intuition would trade a known, documented failure for an unmeasured one.

So the honest framing, and it is now in the README: treat a hit as *something that
was said then*, never as *what is true now*.

## Query expansion was built, measured, and removed

Retrieval is lexical, which is the plugin's real limit — 90.0% recall when a
question reuses the words used at the time, 20.0% when it is reworded. Expanding
the query with synonyms is the obvious fix.

It made things worse. `pizza kubernetes helm` returned four confident,
irrelevant hits. A wrong hit costs tokens *and* sends work down the wrong path,
while a miss costs nothing and is honest. Embeddings would close the gap
properly, at the cost of the zero-dependency property, and that trade has not
been taken.

## Transcript format traps

All of these were found by measurement, and all of them will bite again if the
parser is rewritten:

- **Skill bodies arrive as `user` entries.** One measured 862,714 chars and
  swallowed an entire turn. Filtered by `isMeta: true`.
- **An agentic turn is not conversation-sized** — tens of thousands of chars. Split
  into 6k pieces, each repeating the user's message so it means something alone.
- **`AskUserQuestion` answers ride inside `tool_result`.** Bulk tool output is
  excluded, but by *mass*, not type: the filter is size (≤500 chars). Without
  that, every decision made through that path is lost.
- **Streaming writes each response 2–3 times.** Deduplicated by `requestId`.
- **A corpus term can collide with `Object.prototype`.** `constructor`, `valueOf`
  and `toString` exist on any object literal, so the index uses
  `Object.create(null)`. Without it, indexing a real corpus crashes.
- **The Windows console is cp1252.** A `→` in a chunk truncates the write
  mid-injection. Node writes UTF-8 by default; a port to another runtime must
  check this first.
- **The last turn of a finished session** was never indexed for six releases: the
  reader waited for a following turn that never came. Recovering it added 4,076
  chunks.
- **30% of the index was byte-identical duplicates** — 24 MB, one boilerplate
  string stored 381 times. Chunks are hashed before insert.
- **`compactMetadata` is written after the hook runs.** The boundary line carrying
  `preTokens` lands 3 ms after `SessionStart:compact` fires, and on disk the hook
  gets there first. Anything reading it from a hook has to retry.

## Why the same file is not read twice

Reading a file puts it in the context window and it stays there. Reading it
again, unchanged, puts a second identical copy beside the first. A 2,000-line
file costs about 25,000 tokens each time.

So size and mtime are compared against what this session already read in full,
and an identical read is declined. Three cases are never blocked, because in each
the premise is false: **partial reads** (`offset`/`limit` put only part of the
file in context, and there is no honest way to tell whether the part wanted now
is the part that arrived then), **anything that changed**, and **after a
compaction** — that is precisely when the file leaves the context, so the record
is cleared at the boundary.

On the corpus this was developed against, re-reads of unchanged files were 22.4%
of everything read from disk. That is evidence the mechanism is worth having, not
a number that will hold for anyone else — it is one person's habits on one set of
projects.

This is also the only saving here that needs no history, so it works in the first
hour of a fresh install.

## The skill gate

Invoking a skill inlines its text into the prompt and keeps it there for the rest
of the session. Most are a few KB. One measured **794 KB**, which arrived as a
single **325,000-token cache write** and raised the cost of every remaining turn
— about 75% of that session's bill, for two facts one file would have answered.

Above a threshold the load is declined with a pointer to the specific file worth
reading. Skills are already built for that: `SKILL.md` is an index. Nothing
becomes unreachable; the expensive path stops being automatic.

Finding the right directory to weigh is harder than it sounds. Bundled skills
ship no `SKILL.md` on disk (the harness supplies it), and a skill can contain
subdirectories sharing its own name — `claude-api` ships `python/claude-api`, and
weighing that one reports 46k instead of 794k. A plugin directory can also share
its skill's name, and weighing that reports the whole plugin.

## Routing rules

Whichever model you run will do work far below its pay grade without
complaining: summarising a log, drafting a commit message, translating. Handing
that down is the easiest saving available, and it is a behaviour rather than a
feature — so it ships as a few lines injected once per session.

Written in tiers, not model names, because plenty of people run Sonnet as their
top model and have nothing above it. The line that applies to everyone — cheap
text work goes to Haiku — is also the one that saves the most.

This is the only part of the plugin that spends tokens every session whether it
helps or not: 255, in the cached prefix. One avoided summary pays it back several
times, but it is a bet, not a guaranteed saving.

## Decisions belong in the repo

A decision made in turn 47 of a long session is lost in practice: findable only
by someone who already remembers enough to search for it. It is also what nobody
can reconstruct later — the choice survives in the code, the *reason* does not.

`/decide` appends to `DECISIONS.md` in the repo: dated, branch-tagged,
append-only. In the repo rather than a private index, because a decision is
something a team should see in a diff and be able to argue with. Superseding one
means adding an entry that says so, never editing the old one — that erases the
reason someone once chose differently, which is exactly what the next person
needs.

## Invariants

- **Fail open, always.** Broken index, unreadable file, malformed payload: let the
  turn through. A hook that cannot do its job must not block work.
- **Verbatim on write.** No model touches content on the way in. Summarise only
  when reading, which is reversible.
- **Storing is not indexing.** The transcript is kept whole; a subset is indexed.
- **Nothing in the launcher may depend on PATH.** `run.sh` exists because a hook's
  PATH is not the user's. It once took its own directory from `dirname` — an
  external binary resolved through PATH — and CI caught it launching
  `/recall.mjs`.

## What CI is for

Everything here was built and verified on Windows. The first workflow run found
two defects that had shipped in every release and were invisible by reading:

- `||=` in the index builder, making the documented Node 14 floor false since
  1.0.0.
- `run.sh` resolving `dirname` through the PATH it exists to work around.

Until that release the plugin was, in practice, broken on macOS and Linux. The
matrix is Ubuntu 18/20/22, macOS and Windows, plus one end-to-end pass: empty
index, backfill, retrieve, then a query that must return nothing.
