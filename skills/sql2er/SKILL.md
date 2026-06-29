---
name: sql2er
description: Convert SQL CREATE TABLE statements or DBML into a Chen-model ER diagram (entities, relationships, attributes), auto-lay it out, adjust node positions, and export to drawio/svg/json. Use when the user wants to generate or rearrange an ER diagram from a schema.
---

# sql2er

Pipeline: parse SQL/DBML → build Chen model → lay out → describe → edit → export.

State lives in a JSON file passed via `--state <path>` (default `./sql2er-state.json`); every command in a session uses the same path.

```
node skills/sql2er/scripts/sql2er-agent.mjs <command> [args] [--flags]
```

Runs with just Node ≥18 — the bundle has no npm deps. To rebuild after changing `src/`: `corepack enable && pnpm install && pnpm skill:build` from the repo root.

## Quickstart

```bash
AGENT=skills/sql2er/scripts/sql2er-agent.mjs
node $AGENT generate --input schema.sql --state er.json
node $AGENT describe --state er.json
node $AGENT swap users orders --state er.json
node $AGENT export drawio --out er.drawio --state er.json
```

## Model

A Chen ER diagram is a **skeleton** (entity rectangles + relationship diamonds) plus **attribute ellipses** orbiting each entity. Attribute placement, diamond placement, and overlap separation are computed automatically — only **entity positions** are yours to set.

Attributes are optional: `generate --hide-attrs` builds the **skeleton only** (no ellipses), which lays out tighter and cleaner. Whether the diagram has attributes is fixed **at generate time** — export never adds or drops them.

Structural decisions (crossings, overlaps, isolated tables) come from `describe`'s pre-computed `DIAGNOSTICS` — act on those numbers, not on pixel-counting. But once the diagnostics are clean, do a final **visual** pass: export an image and look at it (see "How to clean up", last step).

Labels default to raw table/column names. For semantic Chen labels (relationships as verbs like "belongs to"), put the term in a COMMENT and use `--comment`, or rename the field in the schema — see `references/data-model.md`.

## Commands

| Command                          | Purpose                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`                       | Parse + build + lay out. Input via `--input <file>`, `--text "<sql>"`, or stdin. Flags: `--format auto\|sql\|dbml`, `--colored`, `--comment`, `--hide-attrs` (skeleton only — no attributes, tighter layout), `--attrs auto\|compact\|moderate`, `--layout optimal\|arrange\|none`. |
| `describe`                       | Print components, entities (id, pos, size, degree, attr counts), relationships (from→to, cardinality), DIAGNOSTICS, ASCII map. Flags: `--full`, `--focus <id\|label>`, `--json`.                                                                                              |
| `layout optimal\|arrange`        | `optimal` (default) = stress-majorize the skeleton with attribute-ring-aware spacing + 2-opt uncross; reserves room so attributes don't overlap — the recommended layout. `arrange` = settle current positions (after edits).                                                |
| `attrs auto\|compact\|moderate`  | How attribute ellipses orbit their entity. `auto` = layout-native; `compact` = tightest non-overlapping pack (hugs the entity, varied distance); `moderate` = one uniform ring (every attribute equidistant). Persists across later layouts/edits.                            |
| `move <id\|label> <x> <y>`       | Place an entity at (x,y); its attributes follow. Runs one `arrange` pass; `--raw` skips it.                                                                                                                                                                                   |
| `nudge <id\|label> <dx> <dy>`    | Shift by delta. `--raw` skips settle.                                                                                                                                                                                                                                         |
| `swap <a> <b>`                   | Exchange two entities' positions. `--raw` skips settle.                                                                                                                                                                                                                       |
| `rotate <degrees>`               | Rotate the diagram about its centre (shapes/text stay upright; positive = clockwise).                                                                                                                                                                                         |
| `fontsize <delta>`               | Global font size. `0` = default; ±1 ≈ ±0.1 scale; clamped 0.4–1.6.                                                                                                                                                                                                            |
| `export drawio\|svg\|json`       | Write output (`--out <file>`, else stdout). `--split` writes one file per disconnected component.                                                                                                                                                                             |

Address entities by exact `id` (from `describe`) or by table name/label if unambiguous.

## How to clean up a diagram

`generate` defaults to `layout optimal`, which usually yields `crossings=0 overlaps=0 attrOverlaps=0 attrCrossings=0` directly. If you've edited positions and want to re-tidy the whole thing, run `layout optimal` again. Otherwise nudge from the diagnostics:

1. `describe` and read DIAGNOSTICS.
2. **crossings / overlaps after manual edits** → `layout optimal` re-tidies from scratch; or `swap` the two entities of a crossing relationship for a local fix.
3. **multiple disconnected clusters** (`COMPONENTS: N > 1`) → stacked top-to-bottom. If they're truly separate diagrams, `export <fmt> --split` → one file per cluster.
4. **attribute look** → `attrs compact` (tight, hugs the entity) vs `attrs moderate` (uniform rings; a pierced ellipse auto-escapes to the nearest clear spot). Both stay overlap-free on an `optimal` skeleton. If a diagram is busy with attributes, consider `generate --hide-attrs` for a skeleton-only view.
5. **aspect ratio off** → `rotate 90`.
6. **Final visual review:** always `export svg` and look at the image before finishing. Ensure it is clear, attractive, legible, and non-overlapping. If overlap is provably unavoidable, minimize it and make each remaining overlap/crossing easy to read.

## References

- `references/commands.md` — full flag reference, `describe` output schema, recipes.
- `references/data-model.md` — node/edge/id conventions, Chen-model semantics, cardinality.
