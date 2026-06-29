# Data model & Chen-model semantics

## Pipeline

```
SQL / DBML text
  → parse        (src/parser/sql.ts → fallback src/parser/dbml.ts)
  → ParseResult  { tables: ParsedTable[], relationships: ParsedRelationship[] }
  → build        (generateChenModelData)  →  { nodes, edges }   (no positions yet)
  → layout       (forceAlignLayout / arrangeLayout)  →  writes x/y onto every node
  → export       (drawio / svg / json)
```

The CLI runs the **real** `src/` parser, builder, and layout against a headless
`GraphLike` adapter (`scripts/engine/adapter.ts`) — there is no second
implementation to drift. Node sizes come from `measureNodeSize()` in
`src/builder.ts`, the same function the renderer uses, so headless geometry is
identical to the web app.

## Node types

| nodeType       | shape     | maps to       | notes                                                                                                   |
| -------------- | --------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `entity`       | rectangle | a table       | `isPlaceholder: true` (dashed) when a FK references a table not in the input                            |
| `attribute`    | ellipse   | a column      | `keyType: "pk"` → underlined; a column that is _only_ a FK is shown as a relationship, not an attribute |
| `relationship` | diamond   | a foreign key | connects exactly two entities (or one, for a self-reference)                                            |

Edges:

| edgeType              | connects                                   | carries                                             |
| --------------------- | ------------------------------------------ | --------------------------------------------------- |
| `entity-attribute`    | entity → attribute                         | —                                                   |
| `entity-relationship` | entity (FK / "many" side) → diamond        | cardinality label on the many side (`N` by default) |
| `relationship-entity` | diamond → entity (referenced / "one" side) | cardinality label on the one side (`1` by default)  |

## Node id conventions (stable — use them to address nodes)

- entity: `entity-<table>-<index>`
- attribute: `attr-<table>-<column>-<tableIndex>-<colIndex>`
- relationship: `rel-<from>-<to>-<label>-<relIndex>`

`describe` prints these ids. In `move`/`nudge`/`swap` you may use the exact id, or
an entity's table name / label when it is unambiguous.

## Cardinality

Defaults follow SQL FK / DBML `>` semantics: many-to-one, so the FK side is `N` and
the referenced side is `1`. A FK column that is itself UNIQUE or a single-column PK
is inferred as `1:1`. `describe` shows each relationship as `from→to  cardFrom:cardTo`.

## Settings (chosen at `generate`, except font)

| setting   | flag                       | effect                                                                                                       |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| colored   | `--colored true\|false`    | colored fills vs black/white. Cosmetic; affects exports only.                                                |
| comment   | `--comment`                | label nodes with table/column comments instead of names (falls back to name when no comment).                |
| hideAttrs | `--hide-attrs`             | skeleton only — no attribute ellipses. Useful for laying out large schemas before attributes are added back. |
| fontScale | `fontsize <delta>` command | global text size; changes node sizes (and therefore spacing). `0` delta = scale `1.0`.                       |

To change colored / comment / hideAttrs after generating, re-run `generate` (positions reset).

## Differences from strict Chen notation

The tool favors usability over textbook strictness (same as the web app):
relationship diamonds are labeled with the FK column name (not a verb like
"owns"), and entities/attributes use raw table/column names. Re-label by editing the
SQL/DBML and regenerating, or accept the defaults.
