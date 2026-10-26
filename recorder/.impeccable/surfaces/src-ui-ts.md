---
version: 1
slug: "src-ui-ts"
primary_target: "src/ui.ts"
related_targets: []
---

# Use screen (live stroke classification)

Mode: Operate. Player glancing 1-2 m from a laptop (phone width must work). Inherits the app's light slate/blue world; no new identity.

## Direction contract
THESIS: One answer owns the screen: the stroke the model just heard, huge, with how sure it is. Refuses the dashboard of equal tiles and the probability pie.
OWN-WORLD: The existing app: slate #20344a ink, blue #2766ad action, pale #edf2f7 ground, white panels with 1px #d0dbe5 lines, Segoe UI, tabular numerals. Stroke identity is the word plus a fixed short code and a distinct hue family; never colour alone.
STORY: The player sees what each stroke was, trusts it when the confidence is high, and sees "unsure" instead of a confident guess; can run a drill against a target stroke.
FIRST VIEWPORT: Top strip: mode switch (Free play / Drill), Fast/Accurate toggle, tally chips per class. Left 7/12: latest stroke name at 110px+, confidence bar with the unsure line, intensity vs recent strokes. Right 5/12: tape of recent strokes, newest first, each row code + name + confidence + intensity bar. Primary control (Fast/Accurate, target picker) in the top strip.
FORM: Rally tape, position 1 on the dealt list (seed 8eaada68), chosen by the user; code-led build.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
