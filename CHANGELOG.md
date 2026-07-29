# Changelog

Newest first. Every figure quoted here was measured on a real session, not
estimated.

## 2.10.0 — the routing rules actually reach a session

`ground_rules.md` shipped in every release and was **reachable only by running a
command nobody runs**. No hook sent it, so the cheapest saving in the whole
plugin — not spending your top model on work a small one does identically — was
never applied. It is now injected at every session start, including after a
compaction, since a rule dropped with the rest of the context stops being
followed.

Two things were wrong with it besides:

- It injected **549 tokens while claiming 150**. The code took everything after
  the first `---`, which swept up the file's own documentation and the
  commented-out optional block. Now it takes only what follows the *last* `---`
  and strips comments: 255 tokens, all of them rules.
- It named Opus as the thinking tier. Plenty of people run Sonnet as their top
  model and have nothing above it, so the rules are written in tiers instead —
  and the line that applies to everyone regardless, cheap text work goes to
  Haiku, is the one that saves the most.

If Ollama answers on `127.0.0.1:11434`, one line names the model found and says
to use it instead of Haiku: the same work for no tokens. Absent, it injects
nothing and costs a refused connection on localhost. `OLLAMA_HOST` to point
elsewhere, `INMEMORY_RULES=0` to send none of it.

## 2.9.0 — two things a fresh install gets on day one

**The POSIX hooks had never been run.** They were `command -v node || exit 0`:
correct, fail-open, and on macOS or Linux with node from nvm, fnm, volta or asdf
they would have found nothing and left the plugin silently inert — a failure
indistinguishable from working and having nothing to say. Hooks now go through
`hooks/run.sh`, which checks the usual install locations and, last, asks the
login shell. Windows is unchanged.

**Reading the same unchanged file twice is now declined.** The second copy is
identical to the one already in context and costs the same tokens again. Size
and mtime decide; an edit, a partial read, or a compaction all make the next read
legitimate. Needs no index, so it works from the first hour rather than after a
corpus accumulates. `INMEMORY_BLOCK_REREADS=0` disables it.

Both of these are aimed at someone who just installed the plugin, which the
previous releases were not: nearly everything else here needs history it does
not have yet.

## 2.8.2

The post-compaction recap announced itself without the token count. It reads the
session transcript, but the line carrying that figure is written by Claude Code
at the same instant the hook runs — 3 ms apart, and on disk the hook got there
first. It now re-reads up to five times, 150 ms apart, and only while the figure
is still missing: 750 ms worst case, against a compaction measured at 129
seconds. A session whose boundary never arrives still gets its recap, just
without the number.

First release exercised by a real compaction rather than a simulated one. Both
`PreCompact` and the recap behaved as designed; the missing figure above was the
only defect it surfaced.

## 2.8.1

The recap keyed off a payload field whose name could not be verified from
outside. Added a second trigger that reads the transcript instead — a
`compact_boundary` written moments ago is a fact on disk rather than a guess
about an API that may be renamed.

## 2.8.0 — compaction stops being a loss

New `PreCompact` hook flushes the index before the boundary, and `SessionStart`
now answers a compaction differently from a fresh start: instead of last week's
work, it hands back the thread that was just summarised away — your own turns,
verbatim, in order.

## 2.7.0

30% of the index was byte-identical duplicates: 24 MB of it, one boilerplate
string stored 381 times. Chunks are now hashed before insert. 14,272 chunks
became 9,822 with nothing lost.

## 2.6.0

The last turn of every finished session was never indexed — the reader waited
for a following turn that never came. Recovered 4,076 chunks that had been
silently missing.

## 2.5.4

`/reindex`, replacing a documented backfill path that never resolved.

## 2.5.3

`claude plugin details` reports the real always-on cost. It is ~607 tokens, not
zero: every command leaves its description in the prompt whether you use it or
not. The README said otherwise and was wrong.

## 2.5.2

The plugin failed to load entirely: the manifest declared `hooks`, `commands`
and `skills`, which are auto-discovered, and the duplicate was rejected. This
would have broken every install. Only `claude plugin list` surfaced it.

## 2.5.1 · 2.5.0

Manifest author and homepage. Once a day at session start, an HTTPS request and
a string compare check for a newer release; one line if there is one, silence
otherwise. `INMEMORY_UPDATE_CHECK=0` disables it.

## 2.4.0 · 2.3.0 · 2.2.0

`/lint`. Install, verification and uninstall documentation.

## 2.1.0 — memory that arrives without being asked

`SessionStart` and a `PreToolUse` file hook: opening a project reports where you
left off, and opening a file brings back the turns that discussed *that file*.
Nothing to type.

## 2.0.0

Skills: `plan`, `design`, `pr`. Each starts by reading what the project already
decided, which is what generic advice cannot do.

## 1.5.0 · 1.4.0 · 1.3.0 · 1.2.0 · 1.1.0

`/decide` (append-only `DECISIONS.md`), the `inmemory` skill, `/duplicates`,
`/standup`, `/map`, `/timeline`, `/digest`, `/topics`.

## 1.0.0

Verbatim recall over the transcripts Claude Code already writes, and the skill
weight gate. No dependencies, no API calls, nothing leaves the machine.

The gate exists because one skill load measured 794 KB — a single 325,000-token
cache write that raised the cost of every remaining turn in that session, and
accounted for 75% of its bill.
