# Command reference, `describe` schema, and recipes

Invoke: `node .claude/skills/sql2er/scripts/sql2er-agent.mjs <command> [args] [--flags]`

Global: `--state <path>` selects the session state file (default
`./sql2er-state.json`). Every command except a fresh `generate` reads it; mutating
commands write it back. Most commands print a fresh `describe` afterward.

## generate

Parse input, build the Chen model, lay it out, write state.

| flag                            | default | meaning                                                           |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `--input <file>`                | —       | read schema from a file                                           |
| `--text "<sql>"`                | —       | inline schema                                                     |
| (piped stdin)                   | —       | used if no `--input`/`--text`                                     |
| `--format auto\|sql\|dbml`      | `auto`  | `auto` tries SQL, falls back to DBML                              |
| `--colored true\|false`         | `true`  | colored vs black/white                                            |
| `--comment`                     | off     | show comments instead of names                                    |
| `--hide-attrs`                  | off     | skeleton only                                                     |
| `--layout align\|arrange\|none` | `align` | initial layout (`none` leaves raw seed positions — rarely useful) |

## describe

Print the current scene. No mutation.

| flag                  | meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `--full`              | also list every attribute with its position                         |
| `--focus <id\|label>` | zoom into one entity: its relationships, neighbours, and attributes |
| `--json`              | machine-readable scene (entities, relationships, diagnostics)       |

### describe output schema

```
COMPONENTS: <n>  (isolated: <k>)      # connected components of entities (via FKs)
  C1 {entityA, entityB, …}

ENTITIES  (id | label | pos | size | deg | attrs)
  <id>  <label> [placeholder]  (x,y)  w×h  deg=<#relations>  attrs=<n>(<p>pk)

RELATIONS  (id | label | from→to | card | pos)
  <id>  <label>  <from>→<to> [self]  <cardFrom>:<cardTo>  (x,y)

DIAGNOSTICS
  ⚠ crossing: <relLabelA> × <relLabelB>     # two FK edges visually cross
  ⚠ overlap:  <nodeA> × <nodeB>             # two skeleton nodes overlap
  ⚠ isolated: <entity>                      # entity with no relationships
  metrics: crossings=<n> overlaps=<n> bbox=<w>×<h> aspect=<r> edgeLen=<n>

MAP  (coarse 2D grid placement; the coords above are authoritative)
  … entities by label, diamonds as ◇label, in their relative cells …
```

The MAP is a gestalt aid only; act on the coordinates and the DIAGNOSTICS list.

## layout `<align|arrange>`

- `align` — topological layout from scratch. Lays the longest entity/relationship
  chain horizontally and fans branches out as subtrees. Deterministic. Best first
  pass and best for trees/chains. Resets positions.
- `arrange` — "smart" settle of the **current** positions: spring forces whose
  deadband preserves the _edge length_ between connected entities (roughly 1×–1.5× of
  the desired spacing), plus 2-opt crossing removal and overlap separation. It keeps
  the coarse structure you set but does **not** pin a node to an exact coordinate —
  nodes drift as the springs balance. Use after manual edits, or to tidy an
  organic/cyclic graph. On dense graphs a single pass can leave one reported overlap;
  running `arrange` again (a discrete op, not a continuous loop) usually clears it.

## move / nudge / swap

Edit entity positions (the only positions you normally set; attributes and diamonds
are derived). By default each runs **one `arrange` settle pass** afterward — this is
the intended "adjust, then one force pass" model.

| command | args                    | notes                                                        |
| ------- | ----------------------- | ------------------------------------------------------------ |
| `move`  | `<id\|label> <x> <y>`   | absolute placement; the entity's attributes move with it     |
| `nudge` | `<id\|label> <dx> <dy>` | relative shift                                               |
| `swap`  | `<a> <b>`               | exchange two entities' positions — the cleanest crossing fix |

`--raw` on any of them skips the settle pass (positions land exactly, nothing else
moves). Canvas is ~1200×800 in layout units, but coordinates are unbounded; the view
is fit on export.

## rotate `<degrees>`

Rotate all node positions about the diagram centre. Shapes and text stay upright
(only centres move). Positive = clockwise. Rigid, so it never creates overlaps.

## fontsize `<delta>`

`0` = default (scale 1.0). Each step ≈ ±0.1 scale; negative shrinks, positive grows;
clamped to the app's 0.4–1.6. Changing the font changes node sizes and therefore
spacing — after a large change, run `layout arrange` to re-pack.

## export `<drawio|svg|json>`

`--out <file>` writes a file; otherwise prints to stdout.

- `drawio` — `.drawio` (mxfile) openable/editable in diagrams.net; same output as the
  web app's XML export, positions preserved.
- `svg` — clean standalone SVG for a visual check.
- `json` — `{ nodes:[{id,type,label,x,y,w,h,pk?,parent?,placeholder?}], edges:[{source,target,label,type}] }`.

`--split` — export one diagram **per disconnected component** (unrelated tables or
clusters) instead of one combined image. With `--out base.ext` it writes
`base-<name>.ext` for each component (named after the component's most-connected
table; duplicates get a numeric suffix). Without `--out` it prints each component's
output separated by `=== component: <name> ===`. A schema with a single connected
component exports normally (and prints a note). Each component keeps its absolute
positions and is framed on its own, so no re-layout is needed.

## Recipes

**Clean diagram, zero fuss**

```
generate --input schema.sql
describe                      # check DIAGNOSTICS
# if crossings: swap the two crossing entities; re-describe; repeat
# if overlaps: layout arrange
export drawio --out er.drawio
```

**Large schema — skeleton first, attributes later**

```
generate --input big.sql --hide-attrs    # place tables without attribute clutter
# move/swap entities until crossings=0 and the MAP is balanced
generate --input big.sql                  # regenerate with attributes (re-layout),
layout arrange                            # or settle attributes around the skeleton
```

**Compare two layouts, keep the better**

```
layout align    && describe   # note crossings
layout arrange  && describe   # note crossings — keep whichever is lower (state holds the last run)
```

**Pin a table to an exact spot**

```
move users 600 400 --raw      # exact placement, no settle — users stays at (600,400)
```

`--raw` is the only way to keep a node at an exact coordinate. A following
`layout arrange` will let the springs move it (the deadband preserves edge _spacing_,
not absolute position). To tidy neighbours without disturbing a pinned node, `nudge`
them individually rather than running a global `arrange`.

**Disconnected tables → separate diagrams**

```
generate --input schema.sql        # unrelated tables are tiled apart, not stacked at origin
describe                           # COMPONENTS: N shows the clusters
export svg --split --out er.svg    # → er-<table>.svg, one per component
```
