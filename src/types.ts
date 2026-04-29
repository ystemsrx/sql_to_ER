export type AttributeLabelMode = "name" | "comment" | "any";
export type NodeType = "entity" | "attribute" | "relationship";
export type KeyType = "pk" | "normal";
// "1" or "N" 端基数。M:N 的两端都是 "N"。
export type Cardinality = "1" | "N";

export interface ParsedColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  // 是否带 UNIQUE 约束。用于推断 FK 是 1:1 还是 N:1：当 FK 列本身唯一时，
  // 即便 DBML 写的是 `>`（多对一），关系也应渲染成 1:1。
  isUnique?: boolean;
  comment?: string;
}

export interface ParsedForeignKey {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface ParsedTable {
  name: string;
  alias?: string;
  columns: ParsedColumn[];
  primaryKeys: string[];
  foreignKeys: ParsedForeignKey[];
  comment?: string;
}

export interface ParsedRelationship {
  from: string;
  to: string;
  label: string;
  // 关系两端基数。缺省视作多对一（fromCardinality="N", toCardinality="1"），
  // 这是 SQL FK 与 DBML `>` 的隐含语义。
  fromCardinality?: Cardinality;
  toCardinality?: Cardinality;
  comment?: string;
}

export interface ParseResult {
  tables: ParsedTable[];
  relationships: ParsedRelationship[];
}

export interface ShapeStyle {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  lineDash?: number[];
  radius?: number;
  shadowColor?: string;
  shadowBlur?: number;
  endArrow?: boolean;
}

export interface LabelConfig {
  style?: {
    fill?: string;
    fontSize?: number;
    fontWeight?: string | number;
    fontStyle?: string;
    fontFamily?: string;
    background?: {
      fill?: string;
      padding?: number[];
      radius?: number;
    };
  };
}

export interface ERNodeModel {
  id: string;
  type?: NodeType | string;
  label?: string;
  x?: number;
  y?: number;
  nodeType?: NodeType;
  keyType?: KeyType;
  parentEntity?: string;
  isPlaceholder?: boolean;
  isSelfLoop?: boolean;
  style?: ShapeStyle;
  labelCfg?: LabelConfig;
  [key: string]: unknown;
}

export interface EREdgeModel {
  id?: string;
  source: string;
  target: string;
  label?: string;
  type?: string;
  edgeType?: "entity-attribute" | "entity-relationship" | "relationship-entity" | string;
  curveOffset?: number;
  style?: ShapeStyle;
  labelCfg?: LabelConfig;
  [key: string]: unknown;
}

export interface ChenModelData {
  nodes: ERNodeModel[];
  edges: EREdgeModel[];
}

export interface NodeSnapshot {
  id: string;
  x?: number;
  y?: number;
  label?: string;
}

export interface SnapshotRecord {
  id: string;
  inputText: string;
  isColored: boolean;
  showComment: boolean;
  hideFields: boolean;
  nodes: NodeSnapshot[];
  thumbnail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GraphNodeLike {
  getModel(): ERNodeModel;
  getBBox(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  getID?(): string;
  getContainer?(): unknown;
  getLinkPoint?: (point: { x: number; y: number }) => { x: number; y: number };
  destroyed?: boolean;
}

export interface GraphEdgeLike {
  getModel(): EREdgeModel;
  destroyed?: boolean;
}

export interface GraphLike {
  destroyed?: boolean;
  getNodes(): GraphNodeLike[];
  getEdges(): GraphEdgeLike[];
  findById(id: string): GraphNodeLike | GraphEdgeLike | null;
  updateItem(item: unknown, model: Record<string, unknown>, stack?: boolean): void;
  setAutoPaint(enabled: boolean): void;
  paint(): void;
  refresh?(): void;
  refreshPositions(): void;
  // G6 内部容器/canvas 等通过键名取，类型不可控；保留 any 是务实选择。
  get(key: string): any;
  getZoom(): number;
  zoomTo?(zoom: number, point?: { x: number; y: number }): void;
  fitView?(padding?: number): void;
  // 生命周期与尺寸控制：useGraph 持有的 G6 实例需要这些；外部 GraphLike
  // 实现可以不暴露。
  clear?(): void;
  destroy?(): void;
  changeSize?(width: number, height: number): void;
}
