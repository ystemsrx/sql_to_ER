# Data model and Chen semantics

Read this when command output needs interpretation, when addressing nodes by id, or when schema labels/cardinality need explanation.

## Node types

| nodeType       | shape     | maps to     | notes                                                                                                   |
| -------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `entity`       | rectangle | table       | `isPlaceholder: true` when a FK references a table missing from the input                               |
| `attribute`    | ellipse   | column      | `keyType: "pk"` is underlined; FK-only columns are represented by relationship diamonds, not attributes |
| `relationship` | diamond   | foreign key | connects two entities, or one entity for a self-reference                                               |

## Edge types

| edgeType              | connects                          | carries                                     |
| --------------------- | --------------------------------- | ------------------------------------------- |
| `entity-attribute`    | entity -> attribute               | no label                                    |
| `entity-relationship` | FK-holding entity -> relationship | cardinality on the FK side (`N` by default) |
| `relationship-entity` | relationship -> referenced entity | cardinality on the referenced side (`1`)    |

## Node ids

Ids are stable and deterministic. Use exact ids from `describe`; add `--full` when attributes need to be addressed.

- entity: `entity-<table>-<index>`
- attribute: `attr-<table>-<column>-<tableIndex>-<colIndex>`
- relationship: `rel-<from>-<to>-<label>-<relIndex>`

## Cardinality

SQL FK and DBML `>` relationships default to many-to-one: the FK-holding side is `N`, and the referenced side is `1`. A FK column that is UNIQUE or a single-column PK is inferred as `1:1`. `describe` prints each relationship as `from->to cardFrom:cardTo`.

Self-referencing FKs render as one relationship diamond with a lens-shaped self-loop.

## Semantic labels

Chen diagrams read best when entities are concepts and relationships are verbs. By default, labels come from raw schema identifiers: entity = table name, attribute = column name, relationship diamond = FK column name.

Set semantic labels before layout tuning:

1. Prefer comments plus `generate --comment` or switch later with `labels mode comment`.
   - SQL: `author_id INT COMMENT 'belongs to'`
   - SQL table comment: `) COMMENT='Article';`
   - DBML column note: `author_id int [note: 'belongs to']`
   - DBML ref note: `Ref: posts.author_id > users.id [note: 'belongs to']`
2. Use `labels set <id> "semantic label"` or `labels batch` for manual labels that should not require regenerating the graph.
3. Rename the FK field only when mutating the schema is acceptable, e.g. `belongs_to INT` so the diamond reads `belongs_to`.

Regenerating with different labels resets positions. `labels mode` keeps manual labels; `labels reset <id|all>` restores the active name/comment label.
