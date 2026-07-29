---
description: Find instructions written for older models, and see what they cost
argument-hint:
---

Run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs" lint
```

Reports two things: what your instruction files cost per turn, and phrasing that
current models no longer need.

The cost split matters. A `CLAUDE.md` is in the prompt on **every turn forever**
— that is the one that compounds. A skill's body is loaded only when invoked;
in the prefix it costs just its description. Do not present a 20,000-token skill
as a 20,000-token-per-turn cost.

On the findings: these are phrasing patterns, not verdicts. Anthropic's
migration notes say prompts written to overcome older models' reluctance now
overtrigger — `CRITICAL: YOU MUST use X` fires when it should not. But a rule
that genuinely is critical, like never printing a credential, keeps its
emphasis. Read each hit and say which ones you would actually change, and why.
