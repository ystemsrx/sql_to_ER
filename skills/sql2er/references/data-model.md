# Data model and Chen semantics

Read this when command output needs interpretation, when moving nodes by id, or when schema labels/cardinality need explanation.

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

Ids are stable and deterministic. Use them in `move`, `nudge`, and `swap` when labels are ambiguous.

- entity: `entity-<table>-<index>`
- attribute: `attr-<table>-<column>-<tableIndex>-<colIndex>`
- relationship: `rel-<from>-<to>-<label>-<relIndex>`

Entity table names or labels may also be used when unambiguous.

## Cardinality

SQL FK and DBML `>` relationships default to many-to-one: the FK-holding side is `N`, and the referenced side is `1`. A FK column that is UNIQUE or a single-column PK is inferred as `1:1`. `describe` prints each relationship as `from->to cardFrom:cardTo`.

Self-referencing FKs render as one relationship diamond with a lens-shaped self-loop.

## Semantic labels

Chen diagrams read best when entities are concepts and relationships are verbs. By default, labels come from raw schema identifiers: entity = table name, attribute = column name, relationship diamond = FK column name.

There is no relabel command. Set semantic labels before layout tuning:

1. Prefer comments plus `generate --comment`.
   - SQL: `author_id INT COMMENT 'belongs to'`
   - SQL table comment: `) COMMENT='Article';`
   - DBML column note: `author_id int [note: 'belongs to']`
   - DBML ref note: `Ref: posts.author_id > users.id [note: 'belongs to']`
2. Rename the FK field only when mutating the schema is acceptable, e.g. `belongs_to INT` so the diamond reads `belongs_to`.

Regenerating with different labels resets positions, so choose labels before manual layout edits.
