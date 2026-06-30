# Command reference

## Contents

- [Invocation and state](#invocation-and-state)
- [generate](#generate)
- [describe](#describe)
- [layout](#layout-optimalarrange)
- [attrs](#attrs-autocompactmoderate)
- [avoid](#avoid-onoff)
- [labels](#labels)
- [move / nudge / swap](#move--nudge--swap)
- [rotate](#rotate-degrees)
- [fontsize](#fontsize-delta)
- [export](#export-drawiosvgpngjsonhtml)
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
| `--auto-avoid true\|false`        | `true`    | automatically move ellipses/diamonds away from overlaps     |
| `--layout optimal\|arrange\|none` | `optimal` | initial layout                                              |

`--hide-attrs` is decided only on `generate`. Later `layout`, `attrs`, and `export` commands keep the saved graph as-is; export has no attribute visibility toggle.

## describe

Print the current scene. Does not mutate state.

| flag           | meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `--full`       | include attributes with positions                                |
| `--focus <id>` | zoom into one entity (its relationships + attributes)            |
| `--json`       | machine-readable: `{ entities[], relationships[], diagnostics }` |

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
  planarity: planar skeleton | non-planar skeleton
  metrics: crossings=<n> overlaps=<n> attrOverlaps=<n> attrCrossings=<n> planar=<true|false> bbox=<w>*<h> aspect=<r> edgeLen=<n>

MAP
  ... entities by label, diamonds as relationship labels, coarsely placed in a grid ...
```

`planarity` is graph-theoretic: it checks the abstract entity-relationship skeleton after ignoring attributes, self-loops, and duplicate relationships. A planar skeleton may still have current `crossings` caused by layout; a non-planar skeleton means some relationship crossings are unavoidable. `overlaps` and `crossings` cover only the skeleton (entities + relationship diamonds). `attrOverlaps` covers any overlap involving an attribute ellipse. `attrCrossings` covers attribute connector crossings, an attribute connector crossing a relationship line, or a relationship line passing through an attribute ellipse.

## layout `<optimal|arrange>`

- `optimal`: default and recommended. Resets positions, lays out the skeleton with stress majorization, removes many planar crossings, separates overlaps, and stacks disconnected components top-to-bottom.
- `arrange`: settles current positions after edits. It preserves the coarse structure but may move nodes while springs balance.

## attrs `<auto|compact|moderate>`

Re-place attribute ellipses around their unchanged entity. The mode persists across later layout/edit commands.

- `auto`: leave layout-native placement untouched.
- `compact`: smallest footprint; attributes hug the entity with varied distances.
- `moderate`: more even ring; attributes use a shared distance unless one must escape to stay clear.

Check the result with `describe` and compare `attrOverlaps` / `attrCrossings`.

## avoid `<on|off>`

Toggle automatic node-overlap avoidance for the saved state. It is on by default and runs after layout/edit/font/label changes. It moves attributes first, relationship diamonds second, and never moves entity rectangles.

```bash
node $AGENT avoid off --state er.json
node $AGENT avoid on --state er.json
```

## labels

Relabel nodes without regenerating or moving the skeleton. Use exact node ids from `describe`.
Manual labels survive `labels mode`; `labels reset` removes them.

```bash
node $AGENT labels set <id> "new label" --state er.json
node $AGENT labels batch --file labels.json --state er.json
node $AGENT labels batch --text '{"rel-orders-users-user_id-7":"placed by","entity-users-0":"Customer"}' --state er.json
node $AGENT labels reset <id|all> --state er.json
node $AGENT labels mode name --state er.json
node $AGENT labels mode comment --state er.json
```

`labels batch` expects a JSON object whose keys are node ids and whose values are strings.
`labels mode name|comment` switches generated labels from each node's stored `nameLabel` /
`commentLabel`; nodes with manual labels keep them until reset.

## move / nudge / swap

- `move <id> <x> <y>`: place a node at absolute coordinates.
- `nudge <id> <dx> <dy>`: shift a node by delta.
- `swap <idA> <idB>`: exchange two entity positions.

Use exact ids from `describe`; run `describe --full` when targeting attributes. Each command runs one `arrange` pass afterward. Use `--raw` to skip settling and automatic avoidance. Coordinates are unbounded; exports fit the view to the graph.

## rotate `<degrees>`

Rotate all node positions about the diagram center. Shapes and text stay upright. Positive values rotate clockwise.

## fontsize `<delta>`

`0` resets to default scale 1.0. Each step is about 0.1 scale; values clamp to 0.4-1.6. After a large font change, run `layout arrange`.

## export `<drawio|svg|png|json|html>`

`--out <file>` writes to a file; otherwise export prints to stdout.

- `drawio`: `.drawio` mxfile editable in diagrams.net
- `svg`: standalone SVG for final visual review
- `png`: raster image rendered from SVG; requires `rsvg-convert` on `PATH` or `SQL2ER_RSVG_CONVERT`
- `json`: `{ nodes:[{id,type,label,x,y,w,h,pk?,parent?,placeholder?}], edges:[{source,target,label,type}] }`
- `html`: self-contained embedded editor seeded with the saved state; users can fine-tune manually and export SVG/PNG/Drawio/JSON

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
node $AGENT export html --out er.html --state er.json --lang zh
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
