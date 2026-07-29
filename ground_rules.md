# Ground rules — model routing

Whichever model you run, it will happily do work far below its pay grade:
summarise a long log, draft a commit message, translate a paragraph, rewrite a
comment. Handing that down is the easiest saving available, and it is a
behaviour rather than a feature — which is why it lives here, as a few lines
injected once per session, instead of as code.

The rules are written in tiers, not model names, on purpose. Plenty of people
run Sonnet as their thinking model and have nothing above it; the rule that
still applies to them is the last one, and it is also the one that saves the
most: cheap text work goes to Haiku no matter what is sitting above it.

Everything below the last `---` in this file is what gets injected. Edit it,
delete it, replace it with your own — nothing in the code depends on the
wording. Comments and prose above that line are never sent.

Cost: 255 tokens per session, in the cached prefix, plus about 25 more if Ollama
is detected. That is the measured figure — an earlier version of this file
claimed 150 while actually injecting 549, because the code took everything after
the first `---` and swept up this documentation with it. Set `INMEMORY_RULES=0`
to send nothing at all.

One avoided summary pays for it several times over. That is the whole bet, and
it is worth stating plainly rather than hiding: this is the only part of the
plugin that spends tokens on every session whether or not it helps.

**Haiku is the default for the cheap tier** because everyone running Claude Code
has it. If Ollama is listening on `127.0.0.1:11434`, a line is added saying so —
a local model does the same text work for free, and detection costs nothing when
it is absent. Point `OLLAMA_HOST` elsewhere if yours is not on the default port.

## Optional: shorter answers

Uncomment the block at the very bottom to make answers terser by default.

It is worth less than it looks. Measured on a real $6.97 session: output was
25,191 tokens = $0.63, 9% of the total. Cutting it 30% saves about $0.19, plus
$0.07 in what is no longer resent on later turns. **About $0.26 of $6.97: 4%.**
Real, but the third lever — one heavy skill load was 75% of that same session.

It also has its own cost: an answer trimmed too far makes you ask again, and the
extra round trip costs more than it saved. That is why it ships off.

To enable it, move those lines below the `---` and remove the `<!--` `-->`.

<!--
- Answer the question. No preamble, no summary of what you just did, no next
  steps unless asked.
- A requested fact is answered with the fact, not a paragraph around it.
- Warnings go in one line, not one section.
- Finishing a task: what changed and where. Not a file-by-file tour.
- None of this applies when prose is what was asked for — an explanation, a
  report, a walkthrough.
-->

---

Push each piece of work to the cheapest tier that still does it right.

- **This session's model thinks:** planning, reasoning about bugs and security,
  deciding, orchestrating. Whatever model it is, it is the expensive one here.
- **A tier below builds,** if you have one: reading, searching, mechanical edits,
  tests. On Opus that is Sonnet subagents; on Sonnet you are already there.
- **Haiku does text with no judgement in it:** summarising long output, drafting
  commits and docs, translating, classifying, extracting. True at every tier —
  none of that needs a model above Haiku.
- Orient with the index before opening files. Read the one file a heavy skill
  points to instead of loading the skill.
- Catching yourself reading a large file or hand-editing many lines is the signal
  to hand it down.
