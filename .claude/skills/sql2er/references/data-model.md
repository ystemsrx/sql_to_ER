# Data model & Chen-model semantics

## Pipeline

```
SQL / DBML text
  → parse     ParseResult { tables, relationships }
  → build     { nodes, edges }    (no positions yet)
  → layout    writes x/y onto every node
  → export    drawio / svg / json
```

## Node types

| nodeType       | shape     | maps to       | notes                                                                                                     |
| -------------- | --------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `entity`       | rectangle | a table       | `isPlaceholder: true` (dashed) when a FK references a table not in the input                              |
| `attribute`    | ellipse   | a column      | `keyType: "pk"` → underlined. A column that is **only** a FK is shown as a relationship, not an attribute |
| `relationship` | diamond   | a foreign key | connects two entities (or one entity for a self-reference)                                                |

## Edge types

| edgeType              | connects                              | carries                                       |
| --------------------- | ------------------------------------- | --------------------------------------------- |
| `entity-attribute`    | entity → attribute                    | —                                             |
| `entity-relationship` | entity (FK / "many" side) → diamond   | cardinality on the many side (`N` by default) |
| `relationship-entity` | diamond → entity (referenced / "one") | cardinality on the one side (`1` by default)  |

## Node ids

Stable and deterministic — use them in `move`/`nudge`/`swap`. You may also use the entity's table name or label if it's unambiguous.

- entity: `entity-<table>-<index>`
- attribute: `attr-<table>-<column>-<tableIndex>-<colIndex>`
- relationship: `rel-<from>-<to>-<label>-<relIndex>`

## Cardinality

Defaults follow SQL FK / DBML `>` semantics: many-to-one. The FK-holding side is `N`; the referenced side is `1`. A FK column that is itself UNIQUE or a single-column PK is inferred as `1:1`. `describe` prints each relationship as `from→to  cardFrom:cardTo`.

## Settings

| setting   | flag                       | effect                                                                |
| --------- | -------------------------- | --------------------------------------------------------------------- |
| colored   | `--colored true\|false`    | colored fills vs black/white (cosmetic; affects exports)              |
| comment   | `--comment`                | use table/column comments as labels (falls back to names when absent) |
| hideAttrs | `--hide-attrs`             | skeleton only — no attribute ellipses                                 |
| fontScale | `fontsize <delta>` command | global text size; changes node sizes and therefore spacing            |

`--colored`, `--comment`, `--hide-attrs` are chosen at `generate`. To change them, re-`generate` (positions reset).

## Notes

- Relationship diamonds are labelled with the FK column name, not a verb. Entities and attributes use raw table/column names. To rename, edit the SQL/DBML and regenerate.
- Self-referencing FKs render as a single self-loop with a lens-shaped arc.
