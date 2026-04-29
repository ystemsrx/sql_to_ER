/**
 * ER Builder Module
 *
 * 包含 Chen 模型 ER 图的数据生成逻辑和 G6 自定义节点注册
 * - generateChenModelData: 生成节点/边数据
 * - G6 自定义节点: entity (矩形), attribute (椭圆), relationship (菱形)
 * - patchRelationshipLinkPoints: 修正菱形节点连线
 */
import type {
  AttributeLabelMode,
  ChenModelData,
  EREdgeModel,
  ERNodeModel,
  GraphLike,
  GraphNodeLike,
  ParsedColumn,
  ParsedRelationship,
  ParsedTable,
} from "./types";

/**
 * 根据 labelMode 与 (name, comment) 计算应显示的标签
 * labelMode: 'name' | 'comment' | 'any'
 *   'name'    - 只显示原名
 *   'comment' - 只显示注释（若注释为空则回退到原名）
 *   'any'     - 显示注释，若无注释则显示原名
 */
const pickLabel = (
  name: string,
  comment: string | undefined,
  labelMode: AttributeLabelMode | string,
): string => {
  const n = name || '';
  const c = comment || '';
  if (labelMode === 'name') return n;
  if (labelMode === 'comment') return c || n;
  return c || n;
};

const resolveAttrLabel = (column: ParsedColumn, labelMode: AttributeLabelMode | string): string =>
  pickLabel(column.name || '', column.comment, labelMode);

const generateChenModelData = (
  tables: ParsedTable[],
  relationships: ParsedRelationship[],
  isColored: boolean = true,
  labelMode: AttributeLabelMode | string = 'name',
  hideFields: boolean = false,
): ChenModelData => {
  const nodes: ERNodeModel[] = [];
  const edges: EREdgeModel[] = [];
  const entityMap = new Map<string, string>(); // 用于存储表名到实体ID的映射

  // Create entity nodes (rectangles) - 不设置固定位置，让布局算法处理
  tables.forEach((table, tableIndex) => {
    const entityId = `entity-${table.name}-${tableIndex}`;
    entityMap.set(table.name, entityId); // 记录映射关系
    if (table.alias) {
      entityMap.set(table.alias, entityId);
    }

    const entityLabel = pickLabel(table.name, table.comment, labelMode);
    nodes.push({
      id: entityId,
      type: 'entity',
      label: entityLabel,
      // 在节点上保留两份候选标签，方便"显示注释"开关原地切换。
      nameLabel: table.name,
      commentLabel: table.comment || table.name,
      // 移除固定的x,y坐标，让布局算法自动处理
      style: {
        fill: '#ffffff',
        stroke: isColored ? '#595959' : '#000000',
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: '#000000',
          fontWeight: 'bold'
        }
      },
      // 添加节点分类信息，用于布局算法
      nodeType: 'entity'
    });

    if (!hideFields) {
      // Create attribute nodes (ellipses) for each column
      table.columns.forEach((column, colIndex) => {
        const attributeId = `attr-${table.name}-${column.name}-${tableIndex}-${colIndex}`;
        const isPrimaryKey = table.primaryKeys.includes(column.name) || column.isPrimaryKey;
        const attrLabel = resolveAttrLabel(column, labelMode);

        nodes.push({
          id: attributeId,
          type: 'attribute',
          label: attrLabel,
          nameLabel: column.name,
          commentLabel: column.comment || column.name,
          // 移除固定位置
          keyType: isPrimaryKey ? 'pk' : 'normal',
          style: {
            fill: isColored ? (isPrimaryKey ? '#f6ffed' : '#fffbe6') : '#ffffff',
            stroke: isColored ? (isPrimaryKey ? '#52c41a' : '#faad14') : '#000000',
            lineWidth: isPrimaryKey ? 2 : 1
          },
          labelCfg: {
            style: {
              fill: '#000000',
              fontWeight: isPrimaryKey ? 'bold' : 'normal'
            }
          },
          nodeType: 'attribute',
          parentEntity: entityId // 标记父实体
        });

        // Connect attribute to entity
        edges.push({
          id: `edge-${entityId}-${attributeId}-${tableIndex}-${colIndex}`,
          source: entityId,
          target: attributeId,
          style: {
            stroke: '#000000'
          },
          edgeType: 'entity-attribute'
        });
      });
    }
  });

  // Create placeholder entities for referenced tables not in the input SQL
  relationships.forEach((rel) => {
    if (!entityMap.has(rel.to)) {
      const placeholderIndex = nodes.filter(n => n.nodeType === 'entity').length;
      const entityId = `entity-${rel.to}-${placeholderIndex}`;
      entityMap.set(rel.to, entityId);

      nodes.push({
        id: entityId,
        type: 'entity',
        label: rel.to,
        nameLabel: rel.to,
        // 占位实体没有解析到的表注释，commentLabel 兜底回原名
        commentLabel: rel.to,
        style: {
          fill: '#ffffff',
          stroke: isColored ? '#595959' : '#000000',
          lineWidth: 2,
          lineDash: [4, 4]
        },
        labelCfg: {
          style: {
            fill: isColored ? '#999999' : '#666666',
            fontWeight: 'bold'
          }
        },
        nodeType: 'entity',
        isPlaceholder: true
      });
    }
  });

  // 根据 from 表 + FK 列名查找列注释，作为关系标签的注释回退源。
  // 例：DBML 没有写 Ref [...note], SQL 也没有 FK 注释，但 FK 列有 COMMENT 'xxx'，
  // 用户开"显示注释"时仍希望关系节点能显示和列同样的描述。
  const tableByName = new Map<string, ParsedTable>();
  tables.forEach((t) => {
    tableByName.set(t.name, t);
    if (t.alias) tableByName.set(t.alias, t);
  });
  const lookupRelComment = (rel: ParsedRelationship): string | undefined => {
    if (rel.comment) return rel.comment;
    const fromTable = tableByName.get(rel.from);
    if (!fromTable) return undefined;
    // 复合 FK label "a, b"：每段都查一遍，把首个有注释的拼回去就行了；
    // 多 FK 列同时有注释的情况罕见，简化处理。
    const cols = rel.label.split(',').map((s) => s.trim()).filter(Boolean);
    for (const c of cols) {
      const found = fromTable.columns.find((col) => col.name === c);
      if (found?.comment) return found.comment;
    }
    return undefined;
  };

  // Create relationship nodes (diamonds) and connections
  relationships.forEach((rel, relIndex) => {
    const relationshipId = `rel-${rel.from}-${rel.to}-${rel.label}-${relIndex}`;
    const isSelfLoop = rel.from === rel.to;

    const relComment = lookupRelComment(rel);
    const relLabel = pickLabel(rel.label, relComment, labelMode);
    nodes.push({
      id: relationshipId,
      type: 'relationship',
      label: relLabel,
      nameLabel: rel.label,
      commentLabel: relComment || rel.label,
      style: {
        fill: isColored ? '#f9f0ff' : '#ffffff',
        stroke: isColored ? '#722ed1' : '#000000',
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: '#000000'
        }
      },
      nodeType: 'relationship',
      isSelfLoop
    });

    // For a self-referencing FK we use a custom edge type (self-loop-arc)
    // that extends single-edge, so both edges compute start/end via the
    // same straight-line getLinkPoint call -- endpoints are therefore
    // identical across the two arcs. A custom getControlPoints places the
    // quadratic control point perpendicular to the straight line with
    // sign taken from model.curveOffset. The two edges keep their natural
    // source/target directions (entity->rel for N, rel->entity for 1) which
    // flips the tangent (and therefore the perpendicular) between them, so
    // BOTH edges use the same positive curveOffset -- after the tangent
    // flip that lands the control points on opposite sides of the straight
    // line, forming a lens/eye shape with no gap at the vertices.

    // 边标签来自解析器推断出的两端基数，缺省 N:1（DBML `>` / SQL FK 的隐含语义）。
    // 1:1（DBML `-`、或 FK 列为单列 PK / UNIQUE 的推断结果）会在两端都标 '1'。
    const fromLabel = rel.fromCardinality ?? 'N';
    const toLabel = rel.toCardinality ?? '1';

    // Connect source entity (the one with the FK, 'many' side) to relationship
    edges.push({
      id: `edge-entity-${rel.from}-${relationshipId}-${relIndex}-1`,
      source: entityMap.get(rel.from),
      target: relationshipId,
      label: fromLabel,
      type: isSelfLoop ? 'self-loop-arc' : undefined,
      curveOffset: isSelfLoop ? 22 : undefined,
      style: {
        stroke: '#000000',
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: '#000000',
          background: {
            fill: '#ffffff',
            padding: [2, 4, 2, 4]
          }
        }
      },
      edgeType: 'entity-relationship'
    });

    // Connect relationship to target entity (the one being referenced, 'one' side)
    edges.push({
      id: `edge-${relationshipId}-entity-${rel.to}-${relIndex}-2`,
      source: relationshipId,
      target: entityMap.get(rel.to),
      label: toLabel,
      type: isSelfLoop ? 'self-loop-arc' : undefined,
      curveOffset: isSelfLoop ? 22 : undefined,
      style: {
        stroke: '#000000',
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: '#000000',
          background: {
            fill: '#ffffff',
            padding: [2, 4, 2, 4]
          }
        }
      },
      edgeType: 'relationship-entity'
    });
  });

  return { nodes, edges };
};

// ========================================
// G6 自定义节点注册
// ========================================

/**
 * 计算文字宽度（考虑中文字符）
 * @param {string} text - 文本内容
 * @param {number} fontSize - 字体大小
 * @returns {number} - 文本宽度
 */
const getTextWidth = (text: string, fontSize: number): number => {
  let width = 0;
  for (let char of text) {
    // 中文字符宽度约等于字体大小，英文字符约为字体大小的0.6倍
    if (/[\u4e00-\u9fa5]/.test(char)) {
      width += fontSize;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
};

interface DiamondLinkContext {
  getBBox(): {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
  };
}
interface Point2D { x: number; y: number; }

/**
 * 菱形节点边界计算函数（供 getLinkPoint 使用）
 */
const calculateDiamondLinkPoint = function (this: DiamondLinkContext, point: Point2D): Point2D {
  const bbox = this.getBBox();
  const centerX = bbox.centerX;
  const centerY = bbox.centerY;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const halfWidth = bbox.width / 2 || 1;
  const halfHeight = bbox.height / 2 || 1;

  // 当目标点与中心重合时直接返回中心，避免除零
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return { x: centerX, y: centerY };
  }

  // 菱形公式：|x|/a + |y|/b = 1
  const t = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
  return {
    x: centerX + dx * t,
    y: centerY + dy * t
  };
};

// G6 4.x 自定义节点 / 边的内部对象（cfg、group、shape、node）
// 没有现成可靠的公开类型，这里在闭包内沿用 any，外部签名仍是强类型。
interface G6Like {
  registerNode(name: string, def: Record<string, unknown>): void;
  registerEdge(name: string, def: Record<string, unknown>, extend?: string): void;
}

// 幂等保护：HMR / 热重载或上层模块多次调用时，G6.registerNode 会覆盖
// 已注册定义并打印警告。用模块级标记保证只注册一次。
let customNodesRegistered = false;

/**
 * 注册 G6 自定义节点 —— 必须在 G6 加载后调用
 * 幂等：同一份 G6 实例下重复调用安全。
 */
const registerCustomNodes = (G6: G6Like): void => {
  if (customNodesRegistered) return;
  customNodesRegistered = true;

  // 实体节点（矩形）
  const drawEntity = (cfg: any, group: any) => {
    const fontSize = 18;
    const text = cfg.label || '';

    const textWidth = getTextWidth(text, fontSize);
    const padding = 10;
    const minWidth = 80;
    const minHeight = 50;

    const width = Math.max(minWidth, textWidth + padding * 2);
    const height = Math.max(minHeight, fontSize + 20);

    const rectAttrs: {
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      stroke: string;
      lineWidth: number;
      lineDash?: number[];
      radius?: number;
      shadowColor?: string;
      shadowBlur?: number;
    } = {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
      fill: cfg.style?.fill || '#fff',
      stroke: cfg.style?.stroke || '#000',
      lineWidth: cfg.style?.lineWidth || 2,
    };
    if (cfg.style?.lineDash) rectAttrs.lineDash = cfg.style.lineDash;
    if (cfg.style?.radius) rectAttrs.radius = cfg.style.radius;
    if (cfg.style?.shadowColor) rectAttrs.shadowColor = cfg.style.shadowColor;
    if (cfg.style?.shadowBlur !== undefined)
      rectAttrs.shadowBlur = cfg.style.shadowBlur;

    const shape = group.addShape('rect', {
      attrs: rectAttrs,
      name: 'entity-shape',
    });

    if (cfg.label) {
      group.addShape('text', {
        attrs: {
          x: 0,
          y: 0,
          text: cfg.label,
          fontSize,
          textAlign: 'center',
          textBaseline: 'middle',
          fill: cfg.labelCfg?.style?.fill || '#000',
          fontWeight: cfg.labelCfg?.style?.fontWeight || 'bold',
          fontStyle: cfg.labelCfg?.style?.fontStyle || 'normal',
        },
        name: 'entity-text',
        capture: false,
      });
    }

    return shape;
  };
  G6.registerNode('entity', {
    draw: drawEntity,
    // 三个写入路径会走这里：
    //   ① 双击节点编辑 label
    //   ② "显示注释"开关切 label
    //   ③ updateGraphStyles 改 style / labelCfg
    // 原先只刷 style/labelCfg、不动 text 内容也不重算尺寸 -> 矩形不变大 +
    // 连线端点不对齐。修法是 in-place 改 attrs（不能 group.clear() —— G6
    // 在外面持有 keyShape 引用，clear 后那只 shape 就被销毁了，连线再调
    // getLinkPoint 时会抛 "getMethod is not a function"）。
    update(cfg: any, node: any) {
      const group = node.getContainer();
      const fontSize = 18;
      const textStr = cfg.label || '';
      const textWidth = getTextWidth(textStr, fontSize);
      const padding = 10;
      const minWidth = 80;
      const minHeight = 50;
      const width = Math.max(minWidth, textWidth + padding * 2);
      const height = Math.max(minHeight, fontSize + 20);

      const shape = group.find((e: any) => e.get('name') === 'entity-shape');
      if (shape) {
        const next: Record<string, unknown> = {
          x: -width / 2,
          y: -height / 2,
          width,
          height,
          fill: cfg.style?.fill ?? shape.attr('fill'),
          stroke: cfg.style?.stroke ?? shape.attr('stroke'),
          lineWidth: cfg.style?.lineWidth ?? shape.attr('lineWidth'),
          lineDash: cfg.style?.lineDash || [0, 0],
          radius: cfg.style?.radius ?? 0,
          shadowColor: cfg.style?.shadowColor ?? '',
          shadowBlur: cfg.style?.shadowBlur ?? 0,
        };
        shape.attr(next);
      }

      let textShape = group.find(
        (e: any) => e.get('name') === 'entity-text',
      );
      if (cfg.label) {
        const labelAttrs: Record<string, unknown> = {
          text: cfg.label,
          fill: cfg.labelCfg?.style?.fill ?? '#000',
          fontWeight: cfg.labelCfg?.style?.fontWeight ?? 'bold',
          fontStyle: cfg.labelCfg?.style?.fontStyle ?? 'normal',
          fontFamily: cfg.labelCfg?.style?.fontFamily,
        };
        if (textShape) {
          textShape.attr(labelAttrs);
        } else {
          group.addShape('text', {
            attrs: {
              x: 0,
              y: 0,
              fontSize,
              textAlign: 'center',
              textBaseline: 'middle',
              ...labelAttrs,
            },
            name: 'entity-text',
            capture: false,
          });
        }
      } else if (textShape) {
        textShape.remove(true);
      }
    },
  });

  // 属性节点（椭圆）
  const drawAttribute = (cfg: any, group: any) => {
    const fontSize = 15;
    const text = cfg.label || '';

    const textWidth = getTextWidth(text, fontSize);
    const padding = 16;
    const minWidth = 60;
    const minHeight = 40;

    const width = Math.max(minWidth, textWidth + padding * 2);
    const height = Math.max(minHeight, fontSize + 16);

    const shape = group.addShape('ellipse', {
      attrs: {
        x: 0,
        y: 0,
        rx: width / 2,
        ry: height / 2,
        fill: cfg.style?.fill || '#fff',
        stroke: cfg.style?.stroke || '#000',
        lineWidth: cfg.style?.lineWidth || 1,
        lineDash: cfg.style?.lineDash,
        shadowColor: cfg.style?.shadowColor,
        shadowBlur: cfg.style?.shadowBlur,
      },
      name: 'attribute-shape',
    });

    if (cfg.label) {
      const isPrimaryKey = cfg.keyType === 'pk';
      group.addShape('text', {
        attrs: {
          x: 0,
          y: 0,
          text: cfg.label,
          fontSize,
          textAlign: 'center',
          textBaseline: 'middle',
          fill: cfg.labelCfg?.style?.fill || '#000',
          fontWeight:
            cfg.labelCfg?.style?.fontWeight ||
            (isPrimaryKey ? 'bold' : 'normal'),
          fontStyle: cfg.labelCfg?.style?.fontStyle || 'normal',
        },
        name: 'attribute-text',
        capture: false,
      });

      if (isPrimaryKey) {
        const underlineWidth = getTextWidth(text, fontSize);
        group.addShape('line', {
          attrs: {
            x1: -underlineWidth / 2,
            y1: 12,
            x2: underlineWidth / 2,
            y2: 12,
            stroke: cfg.labelCfg?.style?.fill || '#000',
            lineWidth: 1,
          },
          name: 'attribute-underline',
        });
      }
    }

    return shape;
  };
  G6.registerNode('attribute', {
    draw: drawAttribute,
    update(cfg: any, node: any) {
      const group = node.getContainer();
      const fontSize = 15;
      const textStr = cfg.label || '';
      const textWidth = getTextWidth(textStr, fontSize);
      const padding = 16;
      const minWidth = 60;
      const minHeight = 40;
      const width = Math.max(minWidth, textWidth + padding * 2);
      const height = Math.max(minHeight, fontSize + 16);
      const isPrimaryKey = cfg.keyType === 'pk';

      const shape = group.find((e: any) => e.get('name') === 'attribute-shape');
      if (shape) {
        shape.attr({
          rx: width / 2,
          ry: height / 2,
          fill: cfg.style?.fill ?? shape.attr('fill'),
          stroke: cfg.style?.stroke ?? shape.attr('stroke'),
          lineWidth: cfg.style?.lineWidth ?? shape.attr('lineWidth'),
          lineDash: cfg.style?.lineDash || [0, 0],
          shadowColor: cfg.style?.shadowColor ?? '',
          shadowBlur: cfg.style?.shadowBlur ?? 0,
        });
      }

      let textShape = group.find(
        (e: any) => e.get('name') === 'attribute-text',
      );
      if (cfg.label) {
        const labelAttrs: Record<string, unknown> = {
          text: cfg.label,
          fill: cfg.labelCfg?.style?.fill ?? '#000',
          fontWeight:
            cfg.labelCfg?.style?.fontWeight ??
            (isPrimaryKey ? 'bold' : 'normal'),
          fontStyle: cfg.labelCfg?.style?.fontStyle ?? 'normal',
          fontFamily: cfg.labelCfg?.style?.fontFamily,
        };
        if (textShape) {
          textShape.attr(labelAttrs);
        } else {
          group.addShape('text', {
            attrs: {
              x: 0,
              y: 0,
              fontSize,
              textAlign: 'center',
              textBaseline: 'middle',
              ...labelAttrs,
            },
            name: 'attribute-text',
            capture: false,
          });
        }
      } else if (textShape) {
        textShape.remove(true);
      }

      // 主键下划线随 keyType / label 变化增删；宽度也得跟新文本走。
      const underline = group.find(
        (e: any) => e.get('name') === 'attribute-underline',
      );
      if (isPrimaryKey && cfg.label) {
        const underlineWidth = getTextWidth(textStr, fontSize);
        if (underline) {
          underline.attr({
            x1: -underlineWidth / 2,
            y1: 12,
            x2: underlineWidth / 2,
            y2: 12,
            stroke: cfg.labelCfg?.style?.fill ?? '#000',
          });
        } else {
          group.addShape('line', {
            attrs: {
              x1: -underlineWidth / 2,
              y1: 12,
              x2: underlineWidth / 2,
              y2: 12,
              stroke: cfg.labelCfg?.style?.fill ?? '#000',
              lineWidth: 1,
            },
            name: 'attribute-underline',
          });
        }
      } else if (underline) {
        underline.remove(true);
      }
    },
  });

  // 关系节点（菱形）
  const drawRelationship = (cfg: any, group: any) => {
    const fontSize = 16;
    const text = cfg.label || '';

    const textWidth = getTextWidth(text, fontSize);
    const horizontalPadding = 24;
    const verticalPadding = 16;
    const minWidth = 80;
    const minHeight = 40;

    const requiredWidth = textWidth + horizontalPadding * 2;
    const requiredHeight = fontSize + verticalPadding * 2;

    const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
    const halfHeight = Math.max(
      minHeight / 2,
      Math.min(halfWidth * 0.6, requiredHeight / 2),
    );

    const shape = group.addShape('polygon', {
      attrs: {
        points: [
          [0, -halfHeight],
          [halfWidth, 0],
          [0, halfHeight],
          [-halfWidth, 0],
        ],
        fill: cfg.style?.fill || '#fff',
        stroke: cfg.style?.stroke || '#000',
        lineWidth: cfg.style?.lineWidth || 2,
        lineDash: cfg.style?.lineDash,
        shadowColor: cfg.style?.shadowColor,
        shadowBlur: cfg.style?.shadowBlur,
      },
      name: 'relationship-shape',
    });

    if (cfg.label) {
      group.addShape('text', {
        attrs: {
          x: 0,
          y: 0,
          text: cfg.label,
          fontSize,
          textAlign: 'center',
          textBaseline: 'middle',
          fill: cfg.labelCfg?.style?.fill || '#000',
          fontWeight: cfg.labelCfg?.style?.fontWeight || 'normal',
          fontStyle: cfg.labelCfg?.style?.fontStyle || 'normal',
        },
        name: 'relationship-text',
        capture: false,
      });
    }

    return shape;
  };
  G6.registerNode('relationship', {
    draw: drawRelationship,
    update(cfg: any, node: any) {
      const group = node.getContainer();
      const fontSize = 16;
      const textStr = cfg.label || '';
      const textWidth = getTextWidth(textStr, fontSize);
      const horizontalPadding = 24;
      const verticalPadding = 16;
      const minWidth = 80;
      const minHeight = 40;

      const requiredWidth = textWidth + horizontalPadding * 2;
      const requiredHeight = fontSize + verticalPadding * 2;
      const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
      const halfHeight = Math.max(
        minHeight / 2,
        Math.min(halfWidth * 0.6, requiredHeight / 2),
      );

      const shape = group.find(
        (e: any) => e.get('name') === 'relationship-shape',
      );
      if (shape) {
        shape.attr({
          points: [
            [0, -halfHeight],
            [halfWidth, 0],
            [0, halfHeight],
            [-halfWidth, 0],
          ],
          fill: cfg.style?.fill ?? shape.attr('fill'),
          stroke: cfg.style?.stroke ?? shape.attr('stroke'),
          lineWidth: cfg.style?.lineWidth ?? shape.attr('lineWidth'),
          lineDash: cfg.style?.lineDash || [0, 0],
          shadowColor: cfg.style?.shadowColor ?? '',
          shadowBlur: cfg.style?.shadowBlur ?? 0,
        });
      }

      let textShape = group.find(
        (e: any) => e.get('name') === 'relationship-text',
      );
      if (cfg.label) {
        const labelAttrs: Record<string, unknown> = {
          text: cfg.label,
          fill: cfg.labelCfg?.style?.fill ?? '#000',
          fontWeight: cfg.labelCfg?.style?.fontWeight ?? 'normal',
          fontStyle: cfg.labelCfg?.style?.fontStyle ?? 'normal',
          fontFamily: cfg.labelCfg?.style?.fontFamily,
        };
        if (textShape) {
          textShape.attr(labelAttrs);
        } else {
          group.addShape('text', {
            attrs: {
              x: 0,
              y: 0,
              fontSize,
              textAlign: 'center',
              textBaseline: 'middle',
              ...labelAttrs,
            },
            name: 'relationship-text',
            capture: false,
          });
        }
      } else if (textShape) {
        textShape.remove(true);
      }
    },
    // 自定义连线计算：使用菱形边界而不是外接矩形
    getLinkPoint: calculateDiamondLinkPoint,
    // 关闭锚点吸附，保证连线直接命中菱形边
    getAnchorPoints() {
      return [];
    },
  });

  // 自引用外键的自环边：扩展 single-edge 以保留**直线**端点计算
  // (single-edge 用 source/target 的另一个端点中心作为 getLinkPoint 的
  // 参考方向，两条自环边的 source/target 完全一致，所以算出来的
  // startPoint / endPoint 也完全一致),再通过 getControlPoints 注入
  // 一个由 model.curveOffset 决定偏移方向的控制点,最后用 getPath
  // 画二次贝塞尔曲线。两条边在端点处严丝合缝,只在中段分向两侧，
  // 形成对称的透镜/眼睛形。
  G6.registerEdge('self-loop-arc', {
    getControlPoints(cfg) {
      const { startPoint, endPoint, curveOffset = 22 } = cfg;
      if (!startPoint || !endPoint) return [];
      const dx = endPoint.x - startPoint.x;
      const dy = endPoint.y - startPoint.y;
      const dist = Math.hypot(dx, dy) || 1;
      const perpX = -dy / dist;
      const perpY = dx / dist;
      return [{
        x: (startPoint.x + endPoint.x) / 2 + perpX * curveOffset,
        y: (startPoint.y + endPoint.y) / 2 + perpY * curveOffset
      }];
    },
    getPath(points) {
      if (!points || points.length < 2) return [];
      const start = points[0];
      const end = points[points.length - 1];
      const control = points.length >= 3 ? points[1] : {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2
      };
      return [
        ['M', start.x, start.y],
        ['Q', control.x, control.y, end.x, end.y]
      ];
    }
  }, 'single-edge');
};

/**
 * 让菱形连线落在真实边界上（而非外接矩形）
 */
const patchRelationshipLinkPoints = (graph: GraphLike): void => {
  const nodes = graph.getNodes();
  nodes.forEach((n: GraphNodeLike) => {
    const model = n.getModel();
    if (model.nodeType !== 'relationship') return;
    // 覆盖当前节点实例的 getLinkPoint，让所有连接重新计算到菱形边
    (n as GraphNodeLike & { getLinkPoint?: typeof calculateDiamondLinkPoint }).getLinkPoint =
      calculateDiamondLinkPoint;
  });

  // 强制边刷新使用新的连线点
  graph.getEdges().forEach((edge) => {
    graph.updateItem(edge, {});
  });
  if (graph.refresh) graph.refresh();
};

/**
 * 仅构建属性节点与实体-属性连边数据
 * 用于在不重新生成整张图的情况下，向现有图中重新添加属性
 */
const buildAttributeData = (
  tables: ParsedTable[],
  isColored: boolean = true,
  labelMode: AttributeLabelMode | string = 'name',
): ChenModelData => {
  const nodes: ERNodeModel[] = [];
  const edges: EREdgeModel[] = [];
  tables.forEach((table, tableIndex) => {
    const entityId = `entity-${table.name}-${tableIndex}`;
    table.columns.forEach((column, colIndex) => {
      const attributeId = `attr-${table.name}-${column.name}-${tableIndex}-${colIndex}`;
      const isPrimaryKey = table.primaryKeys.includes(column.name) || column.isPrimaryKey;
      const attrLabel = resolveAttrLabel(column, labelMode);

      nodes.push({
        id: attributeId,
        type: 'attribute',
        label: attrLabel,
        nameLabel: column.name,
        commentLabel: column.comment || column.name,
        keyType: isPrimaryKey ? 'pk' : 'normal',
        style: {
          fill: isColored ? (isPrimaryKey ? '#f6ffed' : '#fffbe6') : '#ffffff',
          stroke: isColored ? (isPrimaryKey ? '#52c41a' : '#faad14') : '#000000',
          lineWidth: isPrimaryKey ? 2 : 1
        },
        labelCfg: {
          style: {
            fill: '#000000',
            fontWeight: isPrimaryKey ? 'bold' : 'normal'
          }
        },
        nodeType: 'attribute',
        parentEntity: entityId
      });

      edges.push({
        id: `edge-${entityId}-${attributeId}-${tableIndex}-${colIndex}`,
        source: entityId,
        target: attributeId,
        style: { stroke: '#000000' },
        edgeType: 'entity-attribute'
      });
    });
  });
  return { nodes, edges };
};

/**
 * 估算属性节点渲染后的尺寸（与 registerCustomNodes 中 attribute 绘制逻辑保持一致）
 */
const estimateAttributeHalfSize = (label: string | undefined | null): { halfW: number; halfH: number } => {
  const fontSize = 15;
  const padding = 16;
  const minWidth = 60;
  const minHeight = 40;
  const textWidth = getTextWidth(label || '', fontSize);
  const width = Math.max(minWidth, textWidth + padding * 2);
  const height = Math.max(minHeight, fontSize + 16);
  return { halfW: width / 2, halfH: height / 2 };
};

export {
generateChenModelData,
buildAttributeData,
estimateAttributeHalfSize,
registerCustomNodes,
patchRelationshipLinkPoints,
calculateDiamondLinkPoint,
getTextWidth
};
