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

## Semantic labels

A Chen diagram reads best when nodes carry business terms — entities as concepts, **relationships as verbs** ("belongs to" / "owns"), attributes as readable names. By default the tool labels nodes with raw schema identifiers: an entity is the table name, an attribute is the column name, and a relationship diamond is the FK **column** name (`author_id`, not "belongs to"). There is no relabel command — labels come from the input, so set them there:

1. **Comments + `--comment`** (keeps the SQL valid). Put the term in a COMMENT, then `generate --comment`. Labels use the comment and fall back to the name where none exists; toggle by regenerating with/without the flag.
   - SQL: `author_id INT COMMENT 'belongs to'`, and `... ) COMMENT='Article';` for the entity
   - DBML: `author_id int [note: 'belongs to']`, or `Ref: posts.author_id > users.id [note: 'belongs to']`
2. **Rename the field** (non-standard — mutates the schema). Name the FK column itself with the verb so the diamond reads it directly: `CREATE TABLE articles (…, belongs_to INT, FOREIGN KEY (belongs_to) REFERENCES users(id));` → diamond "belongs_to" (an identifier, so no spaces). Simplest, but the column no longer matches a real database column.

Set labels before tuning the layout — regenerating resets positions.

## Notes

- Self-referencing FKs render as a single self-loop with a lens-shaped arc.
