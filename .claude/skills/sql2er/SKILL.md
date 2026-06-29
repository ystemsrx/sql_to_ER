---
name: sql2er
description: Convert SQL CREATE TABLE statements or DBML into a Chen-model ER diagram (entities, relationships, attributes), auto-lay it out, adjust node positions, and export to drawio/svg/json. Use when the user wants to generate or rearrange an ER diagram from a schema.
---

# sql2er

Pipeline: parse SQL/DBML → build Chen model → lay out → describe → edit → export.

State lives in a JSON file passed via `--state <path>` (default `./sql2er-state.json`); every command in a session uses the same path.

```
node .claude/skills/sql2er/scripts/sql2er-agent.mjs <command> [args] [--flags]
```

Runs with just Node ≥18 — the bundle has no npm deps. To rebuild after changing `src/`: `corepack enable && pnpm install && pnpm skill:build` from the repo root.

## Quickstart

```bash
AGENT=.claude/skills/sql2er/scripts/sql2er-agent.mjs
node $AGENT generate --input schema.sql --state er.json
node $AGENT describe --state er.json
node $AGENT swap users orders --state er.json
node $AGENT export drawio --out er.drawio --state er.json
```

## Model

A Chen ER diagram is a **skeleton** (entity rectangles + relationship diamonds) plus **attribute ellipses** orbiting each entity. Attribute placement, diamond placement, and overlap separation are computed automatically — only **entity positions** are yours to set.

Decisions come from `describe`, not from rendered images. Its `DIAGNOSTICS` list (crossings, overlaps, isolated tables) is pre-computed — act on it.

Labels default to raw table/column names. For semantic Chen labels (relationships as verbs like "belongs to"), put the term in a COMMENT and use `--comment`, or rename the field in the schema — see `references/data-model.md`.

## Commands

| Command                         | Purpose                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generate`                      | Parse + build + lay out. Input via `--input <file>`, `--text "<sql>"`, or stdin. Flags: `--format auto\|sql\|dbml`, `--colored`, `--comment`, `--hide-attrs`, `--attrs auto\|compact\|moderate`, `--layout align\|arrange\|none`.    |
| `describe`                      | Print components, entities (id, pos, size, degree, attr counts), relationships (from→to, cardinality), DIAGNOSTICS, ASCII map. Flags: `--full`, `--focus <id\|label>`, `--json`.                                                     |
| `layout align\|arrange`         | `align` = topological re-layout from scratch (resets positions; best for trees/chains). `arrange` = settle current positions (springs + crossing removal; for organic/cyclic graphs or after edits).                                 |
| `attrs auto\|compact\|moderate` | How attribute ellipses orbit their entity. `auto` = layout-native; `compact` = tightest non-overlapping pack (hugs the entity); `moderate` = even concentric rings (uniform distance per ring). Persists across later layouts/edits. |
| `move <id\|label> <x> <y>`      | Place an entity at (x,y); its attributes follow. Runs one `arrange` pass; `--raw` skips it.                                                                                                                                          |
| `nudge <id\|label> <dx> <dy>`   | Shift by delta. `--raw` skips settle.                                                                                                                                                                                                |
| `swap <a> <b>`                  | Exchange two entities' positions. `--raw` skips settle.                                                                                                                                                                              |
| `rotate <degrees>`              | Rotate the diagram about its centre (shapes/text stay upright; positive = clockwise).                                                                                                                                                |
| `fontsize <delta>`              | Global font size. `0` = default; ±1 ≈ ±0.1 scale; clamped 0.4–1.6.                                                                                                                                                                   |
| `export drawio\|svg\|json`      | Write output (`--out <file>`, else stdout). `--split` writes one file per disconnected component.                                                                                                                                    |

Address entities by exact `id` (from `describe`) or by table name/label if unambiguous.

## How to clean up a diagram

1. `describe` and read DIAGNOSTICS.
2. **crossings** → `swap` the two entities of one crossing relationship, or `move` one to the other side.
3. **overlaps** → `layout arrange`. On dense graphs, run it again if a residual remains.
4. **multiple disconnected clusters** (`COMPONENTS: N > 1`) → already tiled apart, not stacked. If they're truly separate diagrams, `export <fmt> --split` → one file per cluster.
5. **aspect ratio off** → `rotate 90` or re-run `layout align`.
6. **messy attributes** (`attrOverlaps > 0` or `attrCrossings > 0`) → `attrs compact` (tight) or `attrs moderate` (even rings); re-`describe` and keep the lower.
7. Stop at `crossings=0`, `overlaps=0`, `attrOverlaps=0`, low `attrCrossings`. Optionally `export svg` to view once.

When `align` and `arrange` disagree, keep whichever has fewer crossings — `align` favours trees/chains, `arrange` favours organic/cyclic.

## References

- `references/commands.md` — full flag reference, `describe` output schema, recipes.
- `references/data-model.md` — node/edge/id conventions, Chen-model semantics, cardinality.
