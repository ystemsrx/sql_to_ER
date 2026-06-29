---
name: sql2er
description: >-
  Turn SQL CREATE TABLE statements or DBML into a Chen-model ER diagram and lay it
  out automatically — headless, no browser. Use when the user wants an ER diagram
  from a schema, or wants to auto-arrange / adjust node positions / export an ER
  diagram (drawio, svg, json) without manually dragging anything. The tool reuses
  this repo's real parser + layout engine, so results match the web app.
---

# sql2er — agent-driven ER diagram layout

This skill drives the project's ER pipeline (parse → build Chen model → layout →
export) from one headless CLI. It is built **for an agent**, not a human: there is
no scroll-zoom, no undo history, no continuous drag. You observe the diagram as
**structured text**, adjust positions with commands, and let one layout pass settle
the result.

## The mental model (read this first)

A Chen ER diagram is a **skeleton** (entity rectangles + relationship diamonds)
with **satellites** (attribute ellipses) hanging off each entity. Satellites,
diamond placement, and overlap separation are _mechanical_ — the engine does them.
Your only real job is the **coarse position of the entities**.

So the loop is:

```
generate  →  describe  →  (move/swap/nudge entities)  →  settles automatically  →  describe  →  … → export
```

**Do not render an image to decide what to move.** Read `describe`: it gives exact
coordinates, stable ids, and a PRE-COMPUTED problem list (crossings, overlaps,
isolated tables). Export an SVG only at the end if you want a visual sanity check.

## Setup (once)

The runnable bundle `scripts/sql2er-agent.mjs` is committed. If you changed any
`src/` parser/builder/layout code, rebuild it:

```
pnpm skill:build      # = node .claude/skills/sql2er/scripts/build.mjs
```

Run the CLI with Node. State lives in a JSON file (`--state`, default
`./sql2er-state.json`); pass the same path to every command in a session.

```
node .claude/skills/sql2er/scripts/sql2er-agent.mjs <command> [...] --state <path>
```

## Quickstart

```bash
AGENT=.claude/skills/sql2er/scripts/sql2er-agent.mjs
node $AGENT generate --input schema.sql --state er.json     # parse + auto layout
node $AGENT describe --state er.json                        # read skeleton + diagnostics
node $AGENT swap users orders --state er.json               # fix a crossing (auto-settles)
node $AGENT export drawio --out er.drawio --state er.json   # editable diagram
```

## Commands (summary)

| Command                       | What it does                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate`                    | Parse `--input <file>` / `--text "<sql>"` / stdin, build, lay out. Flags: `--format auto\|sql\|dbml`, `--colored true\|false`, `--comment`, `--hide-attrs`, `--layout align\|arrange\|none`. |
| `describe`                    | Print skeleton + diagnostics + ASCII map. `--full` adds attributes, `--focus <id\|label>` zooms one entity, `--json` machine output.                                                         |
| `layout <align\|arrange>`     | `align` = topological layout from scratch (best first pass / reset). `arrange` = settle current positions (springs with a deadband that preserves your intent).                              |
| `move <id\|label> <x> <y>`    | Place an entity (its attributes follow), then run one `arrange` settle pass. `--raw` skips the settle.                                                                                       |
| `nudge <id\|label> <dx> <dy>` | Shift by a delta; settles unless `--raw`.                                                                                                                                                    |
| `swap <a> <b>`                | Exchange two entities' positions; settles unless `--raw`. The cleanest fix for edge crossings.                                                                                               |
| `rotate <degrees>`            | Rotate the whole diagram about its centre (shapes/text stay upright).                                                                                                                        |
| `fontsize <delta>`            | Global font size. `0` = default; negative = smaller, positive = larger (≈ ±0.1 scale per step, clamped 0.4–1.6).                                                                             |
| `export <drawio\|svg\|json>`  | Write output (`--out <file>`, else stdout). drawio = editable in diagrams.net; svg = visual check; json = machine round-trip.                                                                |

Entities can be addressed by **exact id** (from `describe`) or by **table name/label**
when unambiguous.

## How to get a clean diagram automatically

`generate` already lays out with `align` (deterministic, good for trees/chains).
Then iterate against the diagnostics — you have an objective, so you don't need to
eyeball anything:

1. `describe` → look at `DIAGNOSTICS`.
2. **Crossings?** `swap` the two entities on one of the crossing relationships, or
   `move` one to the other side. Each edit auto-settles. Re-`describe`.
3. **Overlaps?** Run `layout arrange` (separates nodes while keeping layout), or
   `nudge` the offender.
4. **Isolated tables** (no FKs)? `move` them to an empty corner so they don't sit on
   the connected cluster.
5. **Aspect too wide/tall** for the target page? `rotate 90`, or re-`layout align`.
6. Stop when `crossings=0`, `overlaps=0`, and the `MAP` looks balanced. Optionally
   `export svg` and view it once to confirm.

Try `layout arrange` vs a fresh `layout align` and keep whichever has fewer
crossings — they suit different topologies (arrange = organic/cyclic, align =
tree/chain).

## References

- `references/commands.md` — full flag reference, `describe` output schema, recipes.
- `references/data-model.md` — node/edge/id conventions, Chen-model semantics,
  cardinality rules, what each setting changes.
