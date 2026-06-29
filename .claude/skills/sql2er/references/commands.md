# Command reference

Invoke: `node .claude/skills/sql2er/scripts/sql2er-agent.mjs <command> [args] [--flags]`

`--state <path>` is global (default `./sql2er-state.json`). Every command except a fresh `generate` reads it; mutating commands write it back and print a fresh `describe`.

## generate

Parse, build, lay out, save state.

| flag                              | default | meaning                                                     |
| --------------------------------- | ------- | ----------------------------------------------------------- |
| `--input <file>`                  | —       | read schema from a file                                     |
| `--text "<sql>"`                  | —       | inline schema                                               |
| (piped stdin)                     | —       | used if no `--input`/`--text`                               |
| `--format auto\|sql\|dbml`        | `auto`  | `auto` tries SQL, falls back to DBML                        |
| `--colored true\|false`           | `true`  | colored fills vs black/white                                |
| `--comment`                       | off     | label nodes with comments (falls back to names when absent) |
| `--hide-attrs`                    | off     | skeleton only — no attribute ellipses                       |
| `--attrs auto\|compact\|moderate` | `auto`  | attribute orbit mode (see `attrs` below)                    |
| `--layout align\|arrange\|none`   | `align` | initial layout                                              |

## describe

Print the current scene. Does not mutate state.

| flag                  | meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `--full`              | include attributes with positions                                |
| `--focus <id\|label>` | zoom into one entity (its relationships + attributes)            |
| `--json`              | machine-readable: `{ entities[], relationships[], diagnostics }` |

### Output schema

```
COMPONENTS: <n>  (isolated: <k>)
  C1 {entityA, entityB, …}

ENTITIES  (id | label | pos | size | deg | attrs)
  <id>  <label> [placeholder]  (x,y)  w×h  deg=<#relations>  attrs=<n>(<p>pk)

RELATIONS  (id | label | from→to | card | pos)
  <id>  <label>  <from>→<to> [self]  <cardFrom>:<cardTo>  (x,y)

DIAGNOSTICS
  ⚠ crossing: <relLabelA> × <relLabelB>     # FK edges visually cross
  ⚠ overlap:  <nodeA> × <nodeB>             # two skeleton nodes (entities/diamonds) overlap
  ⚠ isolated: <entity>                      # no relationships at all
  ⚠ attribute overlaps: <n>                 # attribute ellipse overlapping another node
  ⚠ attribute-line crossings: <n>           # entity→attribute line crossing a relationship line
  metrics: crossings=<n> overlaps=<n> attrOverlaps=<n> attrCrossings=<n> bbox=<w>×<h> aspect=<r> edgeLen=<n>

`overlaps`/`crossings` cover only the skeleton (entities + relationship diamonds).
`attrOverlaps` = any overlap involving an attribute ellipse; `attrCrossings` = attribute
connector lines crossing a relationship line (the visual "tangle"). The attribute `attrs`
modes target these two.

MAP
  … entities by label, diamonds as ◇label, coarsely placed in a grid …
```

The MAP is a quick visual; act on coordinates and DIAGNOSTICS.

## layout `<align|arrange>`

- `align` — topological re-layout from scratch. Places the longest entity/relationship chain horizontally; fans branches out as subtrees. Deterministic. **Resets positions.** Best for trees/chains.
- `arrange` — settle current positions: springs + 2-opt crossing removal + overlap separation. Preserves the coarse structure you set but does **not** pin exact coordinates — nodes drift as springs balance. Use after edits or on cyclic graphs. A dense graph may leave one residual overlap; running `arrange` again usually clears it.

## attrs `<auto|compact|moderate>`

Re-place every attribute ellipse around its (unchanged) entity. The mode is stored and re-applied after every later layout/edit, so it persists.

- `auto` — leave whatever the layout produced (the default). Setting `auto` does not re-place; the next `layout`/edit restores the native look.
- `compact` — reuses the app's show-attributes packer: each attribute sits at the shortest radius that clears all nodes and edges, so they hug the entity. Distances vary; non-overlapping. Smallest footprint.
- `moderate` — one uniform ring per entity: **every attribute the same distance** from the entity. The radius is the smallest that fits them side by side (wide attributes get more arc), the ring is rotated to dodge relationship directions, and attributes slide within their slot (angle only, distance fixed) to dodge obstacles and relationship lines. Uniform distance forces a larger footprint than `compact`, so a dense graph may keep a couple of `attrCrossings`/`attrOverlaps`; `compact` is the one that guarantees zero overlaps.

Check the result with `describe` → `attrOverlaps` / `attrCrossings`. Both modes are tidy and non-overlapping; `compact` is the smallest, `moderate` is the most even. On a dense graph a few `attrCrossings` may remain (relationship lines passing over attributes); compare both and keep the lower.

## move / nudge / swap

| command | args                    | effect                                      |
| ------- | ----------------------- | ------------------------------------------- |
| `move`  | `<id\|label> <x> <y>`   | place an entity at (x,y); attributes follow |
| `nudge` | `<id\|label> <dx> <dy>` | shift by delta                              |
| `swap`  | `<a> <b>`               | exchange two entities' positions            |

Each runs one `arrange` pass afterward. `--raw` skips it (positions land exactly, nothing else moves). Canvas is ~1200×800 units; coordinates are unbounded and the view is fit on export.

## rotate `<degrees>`

Rotate all node positions about the diagram centre. Shapes/text stay upright. Positive = clockwise. Rigid — never creates overlaps.

## fontsize `<delta>`

`0` = default scale 1.0. Each step ≈ ±0.1; clamped 0.4–1.6. Changing the font changes node sizes and spacing — after a large change, run `layout arrange`.

## export `<drawio|svg|json>`

`--out <file>` writes to file; otherwise stdout.

- `drawio` — `.drawio` (mxfile) editable in diagrams.net; positions preserved.
- `svg` — standalone SVG.
- `json` — `{ nodes:[{id,type,label,x,y,w,h,pk?,parent?,placeholder?}], edges:[{source,target,label,type}] }`.

`--split` — one file **per disconnected component**. With `--out base.ext` writes `base-<name>.ext` per component (named after each component's most-connected table; dupes get a numeric suffix). Without `--out`, prints each separated by `=== component: <name> ===`. A single-component schema exports normally (with a note).

## Recipes

**Clean diagram**

```
generate --input schema.sql
describe                       # check DIAGNOSTICS
# crossings → swap the two crossing entities
# overlaps  → layout arrange
export drawio --out er.drawio
```

**Large schema: skeleton first**

```
generate --input big.sql --hide-attrs
# move/swap until crossings=0 and the MAP is balanced
generate --input big.sql       # regenerate with attributes
layout arrange                 # settle attributes around the skeleton
```

**Compare layouts**

```
layout align    && describe    # note crossings
layout arrange  && describe    # keep whichever is lower (state holds the last run)
```

**Pin a table to an exact spot**

```
move users 600 400 --raw       # exact placement; stays at (600,400)
```

A following `arrange` will let springs move it. To tidy neighbours without disturbing a pinned node, `nudge` them individually.

**Disconnected tables → separate files**

```
generate --input schema.sql
describe                              # COMPONENTS: N shows the clusters
export svg --split --out er.svg       # → er-<table>.svg per component
```
