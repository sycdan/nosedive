# Knowledge Base

A flat store of markdown documents. Each document is named `<uuid>.md` and is
self-describing via YAML frontmatter. The `<uuid>` is the document's stable
identity; human-readable identity lives in the frontmatter `slug`.

This directory is the single source of truth for reusable content. Some
documents are installable skills that [`nosedive install-skill`](../efforts/installable-skills/install-skill/InstallSkill.md)
materializes into other projects; others are placeholder definitions linked
from effort docs and (eventually) code.

## Frontmatter

Every document has at least:

```yaml
---
id: <uuid>           # matches the filename; see the uuid standard below
kind: <kind>          # skill | placeholder
slug: <slug>         # human identity; unique within the kb; the grep target
description: <line>  # what the doc covers, not a summary of it; for
                     # kind: skill this is the harness invocation trigger
---
```

### `kind: skill`

A user-installable skill. Adds:

```yaml
harnesses: [claude]  # harnesses this skill supports (claude, copilot, ...)
```

`install-skill` picks up `kind: skill` documents and writes the
harness-specific artifact (e.g. `.claude/skills/<slug>/SKILL.md`), generating
that harness's frontmatter from the fields above. The body below the
frontmatter is the skill content, copied verbatim.

### `kind: placeholder`

Defines a metasyntactic variable — a `<token>` that docs write in place of a
concrete value (e.g. `<slug-chain>`, `<uuid>`). This is the canonical place
that token is defined, so it isn't re-explained (and allowed to drift) in each
consumer. The `slug` is the bare token (no angle brackets), which is what makes
[the grep below](#finding-a-canonical-definition) work. Ignored by
`install-skill`. The body is the definition.

## Finding a canonical definition

Docs write a defined term as a placeholder token, e.g. `<slug-chain>`. To find
where it's defined, grep the kb for that slug:

```sh
rg '^slug: slug-chain$' kb
```

If `rg` is not available:

```sh
grep -r "^slug: slug-chain$" kb
```

Every `slug:` is unique, so this resolves to exactly one document — the
canonical definition. (The `<uuid>` naming above is itself defined this way:
`rg '^slug: uuid$' kb`.)

## Conventions

- **uuid** — `<uuid>` means a UUIDv7 minted with a tool; see
  `rg '^slug: uuid$' kb`.
