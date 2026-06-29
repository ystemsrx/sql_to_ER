# Command reference

## Contents

- [Invocation and state](#invocation-and-state)
- [generate](#generate)
- [describe](#describe)
- [layout](#layout-optimalarrange)
- [attrs](#attrs-autocompactmoderate)
- [move / nudge / swap](#move--nudge--swap)
- [rotate](#rotate-degrees)
- [fontsize](#fontsize-delta)
- [export](#export-drawiosvgpngjson)
- [Recipes](#recipes)

## Invocation and state

Invoke from the repo root:

```bash
node skills/sql2er/scripts/sql2er-agent.mjs <command> [args] [--flags]
```

`--state <path>` is global (default `./sql2er-state.json`). Every command except a fresh `generate` reads it; mutating commands write it back and print a fresh `describe`.

## generate

Parse, build, lay out, and save state.

| flag                              | default   | meaning                                                     |
| --------------------------------- | --------- | ----------------------------------------------------------- |
| `--input <file>`                  | -         | read schema from a file                                     |
| `--text "<sql>"`                  | -         | inline schema                                               |
| piped stdin                       | -         | used if no `--input`/`--text`                               |
| `--format auto\|sql\|dbml`        | `auto`    | `auto` tries SQL, falls back to DBML                        |
| `--colored true\|false`           | `true`    | colored fills vs black/white                                |
| `--comment`                       | off       | label nodes with comments (falls back to names when absent) |
| `--hide-attrs`                    | off       | generation-only skeleton mode; no attribute ellipses        |
| `--attrs auto\|compact\|moderate` | `auto`    | attribute orbit mode                                        |
| `--layout optimal\|arrange\|none` | `optimal` | initial layout                                              |

`--hide-attrs` is decided only on `generate`. Later `layout`, `attrs`, and `export` commands keep the saved graph as-is; export has no attribute visibility toggle.

## describe

Print the current scene. Does not mutate state.

| flag                  | meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `--full`              | include attributes with positions                                |
| `--focus <id\|label>` | zoom into one entity (its relationships + attributes)            |
| `--json`              | machine-readable: `{ entities[], relationships[], diagnostics }` |

### Output schema

```text
COMPONENTS: <n>  (isolated: <k>)
  C1 {entityA, entityB, ...}

ENTITIES  (id | label | pos | size | deg | attrs)
  <id>  <label> [placeholder]  (x,y)  w*h  deg=<#relations>  attrs=<n>(<p>pk)

RELATIONS  (id | label | from->to | card | pos)
  <id>  <label>  <from>-><to> [self]  <cardFrom>:<cardTo>  (x,y)

DIAGNOSTICS
  crossing: <relLabelA> x <relLabelB>
  overlap:  <nodeA> x <nodeB>
  isolated: <entity>
  attribute overlaps: <n>
  attribute-line crossings: <n>
  metrics: crossings=<n> overlaps=<n> attrOverlaps=<n> attrCrossings=<n> bbox=<w>*<h> aspect=<r> edgeLen=<n>

MAP
  ... entities by label, diamonds as relationship labels, coarsely placed in a grid ...
```

`overlaps` and `crossings` cover only the skeleton (entities + relationship diamonds). `attrOverlaps` covers any overlap involving an attribute ellipse. `attrCrossings` covers an attribute connector crossing a relationship line, or a relationship line passing through an attribute ellipse.

## layout `<optimal|arrange>`

- `optimal`: default and recommended. Resets positions, lays out the skeleton with stress majorization, removes many planar crossings, separates overlaps, and stacks disconnected components top-to-bottom.
- `arrange`: settles current positions after edits. It preserves the coarse structure but may move nodes while springs balance.

## attrs `<auto|compact|moderate>`

Re-place attribute ellipses around their unchanged entity. The mode persists across later layout/edit commands.

- `auto`: leave layout-native placement untouched.
- `compact`: smallest footprint; attributes hug the entity with varied distances.
- `moderate`: more even ring; attributes use a shared distance unless one must escape to stay clear.

Check the result with `describe` and compare `attrOverlaps` / `attrCrossings`.

## move / nudge / swap

- `move <id|label> <x> <y>`: place an entity at absolute coordinates.
- `nudge <id|label> <dx> <dy>`: shift an entity by delta.
- `swap <a> <b>`: exchange two entity positions.

Each runs one `arrange` pass afterward. Use `--raw` to skip settling. Coordinates are unbounded; exports fit the view to the graph.

## rotate `<degrees>`

Rotate all node positions about the diagram center. Shapes and text stay upright. Positive values rotate clockwise.

## fontsize `<delta>`

`0` resets to default scale 1.0. Each step is about 0.1 scale; values clamp to 0.4-1.6. After a large font change, run `layout arrange`.

## export `<drawio|svg|png|json>`

`--out <file>` writes to a file; otherwise export prints to stdout.

- `drawio`: `.drawio` mxfile editable in diagrams.net
- `svg`: standalone SVG for final visual review
- `png`: raster image rendered from SVG; requires `rsvg-convert` on `PATH` or `SQL2ER_RSVG_CONVERT`
- `json`: `{ nodes:[{id,type,label,x,y,w,h,pk?,parent?,placeholder?}], edges:[{source,target,label,type}] }`

`--split` writes one file per disconnected component. With `--out base.ext`, outputs `base-<name>.ext` per component. Without `--out`, prints each component separated by `=== component: <name> ===`; PNG split export requires `--out`.

## Recipes

Clean diagram:

```bash
node $AGENT generate --input schema.sql --state er.json
node $AGENT describe --state er.json
node $AGENT layout optimal --state er.json
node $AGENT export svg --out er.svg --state er.json
node $AGENT export png --out er.png --state er.json
node $AGENT export drawio --out er.drawio --state er.json
```

Skeleton-only overview:

```bash
node $AGENT generate --input big.sql --hide-attrs --state er.json
node $AGENT describe --state er.json
node $AGENT export svg --out er-skeleton.svg --state er.json
```

Disconnected tables as separate diagrams:

```bash
node $AGENT generate --input schema.sql --state er.json
node $AGENT describe --state er.json
node $AGENT export svg --split --out er.svg --state er.json
```
