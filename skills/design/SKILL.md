---
name: design
description: Use when building or reviewing a UI — a page, a component, a dashboard, a landing page — or when the user says something "looks off", "looks generic", or asks for a design review. Checks against the project's own conventions first, then against principles that survive taste.
---

# Designing and reviewing UI

## First, read what already exists

A component that is beautiful and unlike everything around it has made the
product worse. Before designing anything, find the conventions already in the
repo — they outrank any principle below:

```
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs map               # where components live
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs map <Component>   # a similar one to match
node ${CLAUDE_PLUGIN_ROOT}/hooks/recall.mjs decide --list     # design decisions already made
```

Read one or two existing components in full. Match their spacing scale, their
naming, their approach to state and variants. Consistency with mediocre
conventions beats excellence in isolation — and if the conventions are genuinely
bad, that is a separate conversation to have explicitly, not to resolve by
quietly diverging in one file.

## What actually makes UI look amateur

Almost always one of these, in this order:

**Inconsistent spacing.** Pick one scale (4 / 8 / 12 / 16 / 24 / 32 / 48) and
never use a value outside it. Arbitrary `padding: 13px` reads as sloppy even to
people who cannot name why. This single rule fixes more perceived quality than
any colour choice.

**No type hierarchy.** Three sizes minimum, with real distance between them —
14 / 20 / 32, not 15 / 16 / 18. Weight and colour carry hierarchy as much as
size; a heading that is only 2px larger is not a heading.

**Too many colours, too little contrast.** One accent, one neutral ramp, and
semantic colours only where they mean something. Body text below 4.5:1 contrast
is unreadable for a real fraction of users and looks washed out to everyone
else.

**No breathing room.** Cramped is the most common failure by a wide margin.
When something looks wrong and you cannot say why, add space before adding
anything else.

**Everything the same visual weight.** If the primary action does not stand out
in a squint test, the layout has no hierarchy. Exactly one primary action per
view.

## Avoid the generated look

The default aesthetic of AI-written UI is recognisable and reads as cheap:
purple-to-blue gradients, `Inter` for everything, glassmorphism cards floating
on nothing, emoji as icons, three feature cards in a row with rounded corners
and identical weight, `shadow-lg` on every surface.

None of these are wrong in isolation; together they signal that nobody made a
choice. Make one deliberate decision — a real typeface, a palette with a reason,
a layout that is not a three-card row — and the work stops looking templated.

## Reviewing someone else's UI

Say what specifically is wrong and what to change, with values. "This feels
cluttered" is not actionable; "the card padding is 8px against a 24px page
gutter — bring it to 16 or 24" is.

Separate what is broken from what is taste, and label which is which. Contrast
below 4.5:1, a touch target under 44px, text that breaks at 320px width, a
missing focus ring: those are defects. Whether the accent should be teal is
preference, and presenting preference as a defect burns the credibility you need
for the real findings.

## Non-negotiable regardless of style

Keyboard reachable and visibly focused. Real contrast on text. Alt text that
says something. Labels tied to inputs. Works at 320px. Respects
`prefers-reduced-motion`. These are not polish to add later — retrofitting them
costs multiples of building with them, and skipping them excludes people.

## When the brief is open

Do not silently pick a direction and build it. Propose three or four concrete
directions in one line each — background, accent, typeface, and the reason —
and let the user choose. A described direction costs a sentence to reject; a
built one costs an argument.
