---
name: sql2er
description: Use when the user wants a Chen-model ER diagram from SQL CREATE TABLE statements or DBML, wants to rearrange or clean up an existing sql2er state, wants a skeleton-only overview with attributes hidden at generate time, or needs drawio/svg/png/json exports with final visual review.
---

# sql2er

Use the bundled CLI from the repo root:

```bash
AGENT=skills/sql2er/scripts/sql2er-agent.mjs
```

State lives in one JSON file passed with `--state <path>`; reuse the same state path for every command in a diagram session.

## Core workflow

1. Generate the diagram:

```bash
node $AGENT generate --input schema.sql --state er.json
```

Use `--hide-attrs` only when the user wants an overview/skeleton, the schema is dense, or attributes are not important. Attribute visibility is fixed at `generate`; export never adds or removes attributes. If fields, PKs, or column-level semantics matter, generate with attributes.

Use `--comment` when table/column/ref comments carry readable business labels. Set labels before tuning layout because regenerating resets positions.

If generated names are not semantic enough, relabel nodes before layout tuning:

```bash
node $AGENT labels mode comment --state er.json
node $AGENT labels set rel-orders-users-user_id-7 "placed by" --state er.json
node $AGENT labels batch --file labels.json --state er.json
```

2. Inspect diagnostics:

```bash
node $AGENT describe --state er.json
```

Use `DIAGNOSTICS` for structural decisions: crossings, overlaps, disconnected components, attribute overlaps, and attribute-line crossings. Use the ASCII map only as a rough orientation aid.

3. Improve layout as needed:

```bash
node $AGENT layout optimal --state er.json
node $AGENT attrs compact --state er.json
node $AGENT swap users orders --state er.json
node $AGENT move users 600 400 --state er.json
node $AGENT nudge users 20 -10 --state er.json
```

Automatic overlap avoidance is on by default and moves attributes first, then relationship diamonds, never entity rectangles. Use `avoid off` only when the user explicitly wants to preserve exact positions.

Prefer `layout optimal` after major edits. Use `attrs compact` for the smallest attribute footprint and `attrs moderate` for a more even ring. Use `swap`, `move`, and `nudge` only when diagnostics or visual review show a local issue.

4. Export and review:

```bash
node $AGENT export svg --out er.svg --state er.json
node $AGENT export png --out er.png --state er.json
node $AGENT export drawio --out er.drawio --state er.json
```

Always export SVG or PNG and inspect the image before finishing. Ensure labels are legible, the layout is balanced, and nodes/attribute ellipses do not overlap or sit on top of lines. If overlap or crossings are provably unavoidable, minimize them and make each remaining crossing/overlap clear.

## Cleanup rules

- `crossings` / `overlaps`: run `layout optimal`; for a small local crossing, try `swap`.
- `attrOverlaps` / `attrCrossings`: compare `attrs compact` and `attrs moderate`, then keep the clearer result.
- Unwanted automatic movement: run `avoid off`; turn it back on with `avoid on` before final review when possible.
- `COMPONENTS > 1`: keep related clusters in one diagram, or use `export <fmt> --split` for separate files.
- Awkward aspect ratio: try `rotate 90`.
- Busy attribute-heavy diagram: regenerate with `--hide-attrs` only if a skeleton-only answer satisfies the user.

## References

- Read `references/commands.md` for full command syntax, flags, `describe` output schema, export behavior, and recipes.
- Read `references/data-model.md` when node ids, edge types, cardinality, placeholder entities, self-references, or semantic labels matter.
