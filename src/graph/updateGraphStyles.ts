import type { GraphLike } from "../types";

// G6 updateItem 的"上层 props"字段名/类型很灵活，这里就是装填样式属性的字典。
interface StylesUpdate {
  style?: Record<string, unknown>;
  labelCfg?: { style?: Record<string, unknown> };
  [key: string]: unknown;
}

/**
 * 黑白 / 彩色样式批量切换。直接写到 G6 graph 上，不返回值。
 * 拆出来是为了让 useGraph 不必再持有这一大坨视觉常量。
 */
export const updateGraphStyles = (
  graphInstance: GraphLike | null,
  colored: boolean,
): void => {
  if (!graphInstance || graphInstance.destroyed) return;

  graphInstance.setAutoPaint(false);

  graphInstance.getNodes().forEach((node) => {
    const model = node.getModel();
    const styles: StylesUpdate = {};

    if (colored) {
      if (model.nodeType === "entity") {
        if (model.isPlaceholder) {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            lineDash: [4, 4],
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
              fontStyle: "italic",
            },
          };
        } else {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
            },
          };
        }
      } else if (model.nodeType === "relationship") {
        styles.style = {
          fill: "#f5f3ff",
          stroke: "#8b5cf6",
          lineWidth: 2,
          shadowColor: "rgba(139, 92, 246, 0.2)",
          shadowBlur: 10,
        };
        styles.labelCfg = {
          style: { fill: "#0f172a", fontFamily: "Poppins" },
        };
      } else if (model.nodeType === "attribute") {
        if (model.keyType === "pk") {
          styles.style = {
            fill: "#ecfdf5",
            stroke: "#10b981",
            lineWidth: 2,
            shadowColor: "rgba(16, 185, 129, 0.2)",
            shadowBlur: 5,
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
            },
          };
        } else {
          styles.style = {
            fill: "#ffffff",
            stroke: "#94a3b8",
            lineWidth: 2,
          };
          styles.labelCfg = {
            style: {
              fill: "#475569",
              fontWeight: "normal",
              fontFamily: "Poppins",
            },
          };
        }
      }
    } else {
      styles.style = {
        fill: "#ffffff",
        stroke: "#1e293b",
        lineWidth:
          model.keyType === "pk" ||
          model.nodeType === "entity" ||
          model.nodeType === "relationship"
            ? 2
            : 1,
        shadowBlur: 0,
      };
      if (model.isPlaceholder) {
        styles.style.lineDash = [4, 4];
        styles.style.stroke = "#64748b";
        styles.labelCfg = {
          style: {
            fill: "#64748b",
            fontWeight: "bold",
            fontStyle: "italic",
            fontFamily: "Poppins",
          },
        };
      } else {
        styles.labelCfg = {
          style: {
            fill: "#1e293b",
            fontWeight:
              model.nodeType === "entity" || model.keyType === "pk"
                ? "bold"
                : "normal",
            fontFamily: "Poppins",
          },
        };
      }
    }

    graphInstance.updateItem(node, styles);
  });

  graphInstance.getEdges().forEach((edge) => {
    graphInstance.updateItem(edge, {
      style: {
        stroke: "#000000",
        lineWidth: 1.5,
        endArrow: false,
      },
      labelCfg: {
        style: {
          fill: "#000000",
          fontSize: 12,
          background: {
            fill: "#ffffff",
            padding: [2, 4, 2, 4],
            radius: 2,
          },
        },
      },
    });
  });

  graphInstance.paint();
  graphInstance.setAutoPaint(true);
};
