---
phase: framing
gist: Prevent agents from loading too much of the kb into context — they should follow pertinent links, reference directly, or grep for what they need.
---

# KB context discipline

## Pitch

The kb grows; agents that slurp large swaths of it into context suffer
information overload and context pollution. An agent should load only what the
task at hand needs:

- follow pertinent links from the doc it's already reading,
- reference a specific doc directly (by uuid filename or slug grep),
- grep the kb for the term it needs (`rg '^slug: <term>$' kb`),

rather than bulk-reading `kb/` up front. Framing question: what conventions,
tooling, or foundation-doc rules make the selective path the natural one?
