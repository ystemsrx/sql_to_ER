export type AttributeLabelMode = "name" | "comment" | "any";
export type NodeType = "entity" | "attribute" | "relationship";
export type KeyType = "pk" | "normal";

export interface ParsedColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
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
}

export interface ParsedRelationship {
  from: string;
  to: string;
  label: string;
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
  get(key: string): any;
  getZoom(): number;
  zoomTo?(zoom: number, point?: { x: number; y: number }): void;
  fitView?(padding?: number): void;
}
