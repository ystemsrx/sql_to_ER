/**
 * DBML Parser
 *
 * 基于扫描器的实现：维护字符串字面量 / 花括号 / 方括号的状态，
 * 而不是堆叠正则。能稳定处理：
 *   - 字符串里出现的注释、括号、引号
 *   - 多行属性 [ ... ]、嵌套 Note { ... }、indexes { ... } 块
 *   - Ref 短语句、Ref 块（多条）、内联 ref 属性
 *   - 反引号 / 双引号 / 方括号 / 中文标识符
 *   - schema.table.column 的多段限定符（取最后两段；引号 / 括号感知，
 *     "my.table" 这种带点引用名整体保留，不被误拆）
 *   - 复合类型 decimal(10,2) / varchar(255)
 *   - 数组类型后缀 int[] / int[][] / decimal(10,2)[]（与列尾设置块 [...] 区分）
 *   - indexes { (a,b) [pk] / col [unique] } 块里的复合主键与单列唯一约束
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
} from "../types";

const IDENT = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w一-龥]+)`;
// schema-qualified 标识符：a / a.b / a.b.c。每段都允许带引号 / 反引号 / 方括号。
const QUALIFIED_IDENT = String.raw`${IDENT}(?:\.${IDENT})*`;

// 去掉一段标识符外层的引号 / 反引号 / 方括号。
const stripOuterQuotes = (seg: string): string => seg.trim().replace(/^[`"\[]|[`"\]]$/g, "");

// 按 `.` 切分限定标识符，但 `.` 出现在引号 / 反引号 / 方括号 / 圆括号内部时不切。
// => `"my.table"` 是一段而非两段；复合列 `(a, b)` 也保持完整。
const splitQualified = (raw: string): string[] => {
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  let paren = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      cur += ch;
      i++;
      while (i < raw.length) {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          cur += raw[i] + raw[i + 1];
          i += 2;
          continue;
        }
        if (raw[i] === q) {
          cur += q;
          i++;
          break;
        }
        cur += raw[i++];
      }
      continue;
    }
    if (ch === "[") {
      cur += ch;
      i++;
      while (i < raw.length) {
        if (raw[i] === "]" && raw[i + 1] === "]") {
          cur += "]]";
          i += 2;
          continue;
        }
        if (raw[i] === "]") {
          cur += "]";
          i++;
          break;
        }
        cur += raw[i++];
      }
      continue;
    }
    if (ch === "(") {
      paren++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      paren--;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "." && paren === 0) {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
};

const cleanIdentifier = (raw: string): string => {
  const parts = splitQualified(raw);
  const last = parts.length ? parts[parts.length - 1] : raw.trim();
  return stripOuterQuotes(last) || raw.trim();
};

const stripQuotes = (s: string): string => {
  const t = s.trim();
  if (t.startsWith("'''") && t.endsWith("'''") && t.length >= 6) {
    return t.slice(3, -3);
  }
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first === last && (first === "'" || first === '"' || first === "`")) {
      return t.slice(1, -1).replace(/\\(.)/g, "$1");
    }
  }
  return t;
};

// 跳过字符串字面量；i 指向首个引号，返回字符串结束后的下标。
const skipString = (src: string, i: number): number => {
  if (src[i] === "'" && src[i + 1] === "'" && src[i + 2] === "'") {
    let j = i + 3;
    while (j < src.length && !(src[j] === "'" && src[j + 1] === "'" && src[j + 2] === "'")) {
      j++;
    }
    return Math.min(src.length, j + 3);
  }
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\" && j + 1 < src.length) {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    j++;
  }
  return j;
};

const stripDbmlComments = (src: string): string => {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // 兼容 SQL 风格 `--` 行注释。DBML 规范没要求支持，但我们的输入框是 SQL/DBML
    // 共用的，示例和很多用户的 DBML 顶部都会带 SQL 风格说明文字。
    if (ch === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(src.length, i + 2);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};

const findMatchingBrace = (src: string, openIdx: number): number => {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
};

const findMatchingBracket = (src: string, openIdx: number): number => {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
};

const indexOfUnquoted = (s: string, needle: string, from = 0): number => {
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (s.startsWith(needle, i)) return i;
    i++;
  }
  return -1;
};

const splitTopLevelCommas = (s: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipString(s, i);
      cur += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

// 把表体拆成"逻辑行"：换行只在没有 [...] 或 { ... } 包裹时才是行边界。
const splitLogicalLines = (body: string): string[] => {
  const lines: string[] = [];
  let cur = "";
  let bracketDepth = 0;
  let braceDepth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipString(body, i);
      cur += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "]") {
      bracketDepth--;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "}") {
      braceDepth--;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "\n" && bracketDepth <= 0 && braceDepth <= 0) {
      if (cur.trim()) lines.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) lines.push(cur);
  return lines;
};

interface RefTarget {
  table: string;
  column: string;
}

const parseRefTarget = (raw: string): RefTarget | null => {
  // 仅去掉首尾游离的逗号（来自 splitTopLevelCommas 拆开内联 ref 时残留）。
  // 不要再剥圆括号 —— 复合外键 `table.(col_a, col_b)` 的右括号会被误吃，
  // 历史上写过 `^[(,]|[),]$` 是按"防御性清洗"思路写的，现在已无必要。
  let cleaned = raw
    .trim()
    .replace(/^,+|,+$/g, "")
    .trim();
  // 去掉尾部 `[delete: cascade, update: cascade]` 这类设置块。
  // Ref: a.b > c.d [...] 时，右目标会粘上 `[...]`，必须先剥掉再分段。
  const lb = indexOfUnquoted(cleaned, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(cleaned, lb);
    if (rb !== -1) {
      cleaned = (cleaned.slice(0, lb) + " " + cleaned.slice(rb + 1)).trim();
    }
  }
  if (!cleaned) return null;
  // 用引号 / 括号感知的切分：`"my.tbl".col` 取 my.tbl + col；
  // 复合列 `(a, b)` 保持完整不被 `.` 或逗号拆散。
  const segs = splitQualified(cleaned).map(stripOuterQuotes).filter(Boolean);
  if (segs.length < 2) return null;
  // 复合列 `(col_a, col_b)` —— 去掉外层括号当作 label，避免出现 `(col_a, col_b)`
  // 这种带括号的边标签。table 与 column 仍按原始 segs 取，column 拿掉括号后
  // 用于显示。
  let column = segs[segs.length - 1];
  const composite = column.match(/^\(\s*([\s\S]+?)\s*\)$/);
  if (composite) {
    column = composite[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
  }
  return { table: segs[segs.length - 2], column };
};

const parseInlineRef = (refValue: string): { op: string; target: RefTarget } | null => {
  const m = refValue.match(/^\s*(<>|[<>\-])\s*(.+)$/);
  if (!m) return null;
  const target = parseRefTarget(m[2]);
  return target ? { op: m[1], target } : null;
};

interface ColumnAttr {
  key: string;
  value: string | null;
}

const parseColumnAttrs = (attrsRaw: string): ColumnAttr[] =>
  splitTopLevelCommas(attrsRaw).map<ColumnAttr>((part) => {
    const colon = indexOfUnquoted(part, ":");
    if (colon === -1) {
      return {
        key: part.trim().toLowerCase().replace(/\s+/g, " "),
        value: null,
      };
    }
    return {
      key: part.slice(0, colon).trim().toLowerCase().replace(/\s+/g, " "),
      value: part.slice(colon + 1).trim(),
    };
  });

interface ColumnLineResult {
  column: ParsedColumn | null;
  inlineRef: { target: RefTarget; op: string } | null;
}

// 找列定义末尾的设置块 `[...]`。难点是要把它和两类“看起来像方括号”的东西区分开：
//   1. 数组类型后缀 `int[]` / `int[3]`（内容为空或纯数字）—— 属于类型，不是设置块。
//   2. 行首的方括号引用标识符 `[my col]`（前面没有 name+type）—— 是列名，不是设置块。
// 取“最后一个、且前面有非空头部、内容不像数组后缀”的顶层方括号作为设置块。
const findSettingsBracket = (s: string): { lb: number; rb: number } | null => {
  let i = 0;
  let last: { lb: number; rb: number } | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "[") {
      const rb = findMatchingBracket(s, i);
      if (rb === -1) break;
      // 设置块前必须有“name type”这段头部，排除行首的方括号标识符。
      if (s.slice(0, i).trim() !== "") last = { lb: i, rb };
      i = rb + 1;
      continue;
    }
    i++;
  }
  if (!last) return null;
  const content = s.slice(last.lb + 1, last.rb).trim();
  if (content === "" || /^\d+$/.test(content)) return null; // 数组后缀，非设置块
  return last;
};

const parseColumnLine = (line: string): ColumnLineResult => {
  const trimmed = line.trim();
  // 头部 = 'name type'，尾部可选 [attrs]
  const sb = findSettingsBracket(trimmed);
  let head: string;
  let attrsRaw = "";
  if (sb) {
    head = trimmed.slice(0, sb.lb).trim();
    attrsRaw = trimmed.slice(sb.lb + 1, sb.rb);
  } else {
    head = trimmed;
  }
  const m = head.match(new RegExp(String.raw`^(${IDENT})\s+([\s\S]+)$`));
  if (!m) return { column: null, inlineRef: null };
  const name = cleanIdentifier(m[1]);
  const type = m[2].trim().replace(/\s+/g, " ");

  let isPrimaryKey = false;
  let isUnique = false;
  let inlineRef: ColumnLineResult["inlineRef"] = null;
  let comment: string | undefined;

  if (attrsRaw) {
    for (const attr of parseColumnAttrs(attrsRaw)) {
      if (attr.key === "pk" || attr.key === "primary key") {
        isPrimaryKey = true;
      } else if (attr.key === "unique") {
        isUnique = true;
      } else if (attr.key === "ref" && attr.value) {
        const r = parseInlineRef(attr.value);
        if (r) inlineRef = r;
      } else if (attr.key === "note" && attr.value) {
        comment = stripQuotes(attr.value);
      }
    }
  }

  const column: ParsedColumn = { name, type, isPrimaryKey };
  if (isUnique) column.isUnique = true;
  if (comment !== undefined) column.comment = comment;
  return { column, inlineRef };
};

interface ParsedRefStatement {
  from: RefTarget;
  to: RefTarget;
  op: string;
  comment?: string;
}

// Ref 顶层 settings 块 `[delete: cascade, note: 'xxx']` 中的 note 是关系注释。
// 拆出来：返回 (剥掉外层 [...] 后的 body, 提取到的 note 字符串)。
const stripRefSettings = (body: string): { body: string; comment?: string } => {
  let cleaned = body;
  let comment: string | undefined;
  const lb = indexOfUnquoted(cleaned, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(cleaned, lb);
    if (rb !== -1) {
      const inner = cleaned.slice(lb + 1, rb);
      // 注意 parseRefTarget 也会剥掉粘在右目标后面的 [...]；这里 stripRefSettings
      // 只是把"留在 body 里的 settings 文字"再抽一层 note 出来供关系节点显示。
      for (const attr of splitTopLevelCommas(inner)) {
        const colon = indexOfUnquoted(attr, ":");
        if (colon === -1) continue;
        const key = attr.slice(0, colon).trim().toLowerCase();
        const value = attr.slice(colon + 1).trim();
        if (key === "note") comment = stripQuotes(value);
      }
      cleaned = (cleaned.slice(0, lb) + " " + cleaned.slice(rb + 1)).trim();
    }
  }
  return { body: cleaned, comment };
};

const parseRefBody = (rawBody: string): ParsedRefStatement | null => {
  const { body, comment } = stripRefSettings(rawBody);
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(body, i);
      continue;
    }
    if (body.startsWith("<>", i)) {
      const left = body.slice(0, i).trim();
      const right = body.slice(i + 2).trim();
      const from = parseRefTarget(left);
      const to = parseRefTarget(right);
      return from && to ? { from, to, op: "<>", ...(comment ? { comment } : {}) } : null;
    }
    if (ch === "<" || ch === ">" || ch === "-") {
      const left = body.slice(0, i).trim();
      const right = body.slice(i + 1).trim();
      const from = parseRefTarget(left);
      const to = parseRefTarget(right);
      if (from && to) return { from, to, op: ch, ...(comment ? { comment } : {}) };
    }
    i++;
  }
  return null;
};

interface TopStatement {
  kind: "table" | "ref" | "refblock" | "enum" | "project" | "tablegroup" | "unknown";
  header: string;
  body: string | null;
}

const classifyHeader = (header: string): TopStatement["kind"] => {
  // 注意：先于 `Table\b` 判 TablePartial / TableGroup，否则前者会被吞。
  if (/^TablePartial\b/i.test(header)) return "unknown";
  if (/^TableGroup\b/i.test(header)) return "tablegroup";
  if (/^Table\b/i.test(header)) return "table";
  // Ref 短句：`Ref:` 或 `Ref name:`，可能换行后才进入正文
  if (/^Ref\b[^{]*:/i.test(header)) return "ref";
  if (/^Ref\b/i.test(header)) return "refblock";
  if (/^Enum\b/i.test(header)) return "enum";
  if (/^Project\b/i.test(header)) return "project";
  if (/^DiagramView\b/i.test(header)) return "unknown";
  if (/^records\b/i.test(header)) return "unknown";
  if (/^Note\b/i.test(header)) return "unknown";
  return "unknown";
};

// 把 TablePartial / DiagramView / records / Note 也纳入识别：
// 否则 findNextKeyword 会逐字符地走过它们的 body 内容（包含 jsonb 字面量、
// 反引号表达式、Markdown 文本等），有概率撞上像 `TableGroup` 这样的字眼并误识别。
// 这里识别后仍然分类为 'unknown' 在主循环里跳过。
// 顺序：长前缀放在前面（TablePartial 在 Table 前，TableGroup 在 Table 前），
// 否则 `Table\b` 会优先返回但匹配失败浪费一次。
const TOP_KEYWORD_RE =
  /^(TablePartial|TableGroup|Table|Ref|Project|Enum|DiagramView|records|Note)\b/i;

// 从 from 开始找下一处可能开启顶层语句的关键字位置（必须在词边界，
// 且当前不在字符串字面量里）。找不到返回 -1。
const findNextKeyword = (src: string, from: number): number => {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    const prev = i > 0 ? src[i - 1] : "";
    const isWordBoundary = !prev || !/[\w一-龥]/.test(prev);
    if (isWordBoundary && TOP_KEYWORD_RE.test(src.slice(i))) {
      return i;
    }
    i++;
  }
  return -1;
};

const tokenizeTopLevel = (src: string): TopStatement[] => {
  const out: TopStatement[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    // 跳过未识别内容（注释残留、随手写的说明文字、占位符等）直到下一个关键字。
    const startIdx = findNextKeyword(src, i);
    if (startIdx === -1) break;
    i = startIdx;

    let braceIdx = -1;
    let lineEndIdx = -1;
    let bracketDepth = 0;
    let seenOperator = false;
    let j = i;
    while (j < n) {
      const ch = src[j];
      if (ch === "'" || ch === '"' || ch === "`") {
        j = skipString(src, j);
        continue;
      }
      if (ch === "[") {
        bracketDepth++;
        j++;
        continue;
      }
      if (ch === "]") {
        if (bracketDepth > 0) bracketDepth--;
        j++;
        continue;
      }
      if (ch === "{" && bracketDepth === 0) {
        braceIdx = j;
        break;
      }
      // Ref 短句的关系运算符（仅在顶层、未在 [...] 设置块里时计数）。
      // 多行 `Ref name:\n  a > b [...]` 形式时：`:` 后面的换行不能立刻
      // 终止语句 —— 至少要等到运算符出现，才认为左 / 右目标都已就位。
      if (bracketDepth === 0 && (ch === "<" || ch === ">" || ch === "-")) {
        seenOperator = true;
      }
      if (ch === "\n" && bracketDepth === 0 && seenOperator) {
        const head = src.slice(startIdx, j).trim();
        if (/^Ref\b[^{]*:/i.test(head)) {
          lineEndIdx = j;
          break;
        }
      }
      j++;
    }

    if (braceIdx !== -1) {
      const header = src.slice(startIdx, braceIdx).trim();
      const closeIdx = findMatchingBrace(src, braceIdx);
      if (closeIdx === -1) break;
      const body = src.slice(braceIdx + 1, closeIdx);
      out.push({ kind: classifyHeader(header), header, body });
      i = closeIdx + 1;
      continue;
    }

    if (lineEndIdx !== -1) {
      const header = src.slice(startIdx, lineEndIdx).trim();
      if (header) out.push({ kind: classifyHeader(header), header, body: null });
      i = lineEndIdx + 1;
      continue;
    }

    // 文件尾部，无 '{'、无换行
    const header = src.slice(startIdx).trim();
    if (header) out.push({ kind: classifyHeader(header), header, body: null });
    break;
  }
  return out;
};

const parseTableHeader = (header: string): { name: string; alias?: string } | null => {
  // 去掉头部 [headercolor: #abc] 之类的 settings
  let h = header;
  const lb = indexOfUnquoted(h, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(h, lb);
    if (rb !== -1) h = (h.slice(0, lb) + " " + h.slice(rb + 1)).trim();
  }
  const m = h.match(
    new RegExp(String.raw`^Table\s+(${QUALIFIED_IDENT})(?:\s+as\s+(${IDENT}))?\s*$`, "i"),
  );
  if (!m) return null;
  return {
    name: cleanIdentifier(m[1]),
    alias: m[2] ? cleanIdentifier(m[2]) : undefined,
  };
};

// DBML 关系运算符 → 两端基数。
//   `>`  many-to-one  (默认 FK 方向)
//   `<`  one-to-many
//   `-`  one-to-one
//   `<>` many-to-many
const opToCardinality = (
  op: string,
): { from: import("../types").Cardinality; to: import("../types").Cardinality } => {
  switch (op) {
    case "<":
      return { from: "1", to: "N" };
    case "-":
      return { from: "1", to: "1" };
    case "<>":
      return { from: "N", to: "N" };
    case ">":
    default:
      return { from: "N", to: "1" };
  }
};

const addRelationship = (
  ref: ParsedRefStatement,
  relationships: ParsedRelationship[],
  tableByName: Map<string, ParsedTable>,
): void => {
  const card = opToCardinality(ref.op);
  relationships.push({
    from: ref.from.table,
    to: ref.to.table,
    label: ref.from.column,
    fromCardinality: card.from,
    toCardinality: card.to,
    ...(ref.comment ? { comment: ref.comment } : {}),
  });
  const t = tableByName.get(ref.from.table);
  if (t) {
    t.foreignKeys = t.foreignKeys || [];
    t.foreignKeys.push({
      column: ref.from.column,
      referencedTable: ref.to.table,
      referencedColumn: ref.to.column,
    });
  }
};

// 从表 body 中提取 `Note: '...'` 或 `Note { '...' }` 作为表级注释。
// 不修改原 body —— 调用方会照常用 splitLogicalLines 跳过 Note 行。
const extractTableNote = (body: string): string | undefined => {
  const lines = splitLogicalLines(body);
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^Note\s*[:{]/i.test(line)) continue;
    const afterNote = line.slice(4).trim();
    if (afterNote.startsWith(":")) {
      const v = afterNote.slice(1).trim();
      if (v) return stripQuotes(v);
      continue;
    }
    if (afterNote.startsWith("{")) {
      const close = findMatchingBrace(afterNote, 0);
      if (close === -1) continue;
      const inner = afterNote.slice(1, close).trim();
      if (inner) return stripQuotes(inner);
    }
  }
  return undefined;
};

// indexes 块里一条索引的列：单列 / `(a, b)` 复合 / `` `expr` `` 表达式（返回 null）。
const parseIndexColumns = (head: string): string[] | null => {
  const h = head.trim();
  if (h.startsWith("`")) return null; // 表达式索引，无对应列
  if (h.startsWith("(")) {
    const inner = h.replace(/^\(|\)$/g, "");
    return splitTopLevelCommas(inner).map(cleanIdentifier).filter(Boolean);
  }
  const c = cleanIdentifier(h);
  return c ? [c] : null;
};

// 解析表内 `indexes { ... }` 块，抽取复合主键与单列唯一约束。dbdiagram 导出的
// DBML 常把复合主键写成 `(a, b) [pk]`，把唯一约束写成 `col [unique]`。
//   indexes {
//     (a, b) [pk]        -> 复合主键 a, b
//     email [unique]     -> email 列唯一（参与 1:1 推断）
//   }
const extractIndexesConstraints = (
  blockBody: string,
): { pkCols: string[]; uniqueCols: string[] } => {
  const pkCols: string[] = [];
  const uniqueCols: string[] = [];
  for (const raw of splitLogicalLines(blockBody)) {
    const line = raw.trim();
    if (!line) continue;
    const sb = findSettingsBracket(line);
    if (!sb) continue; // 没有 [settings] -> 没有 pk/unique 可抽取
    const head = line.slice(0, sb.lb).trim();
    let isPk = false;
    let isUnique = false;
    for (const attr of parseColumnAttrs(line.slice(sb.lb + 1, sb.rb))) {
      if (attr.key === "pk" || attr.key === "primary key") isPk = true;
      else if (attr.key === "unique") isUnique = true;
    }
    if (!isPk && !isUnique) continue;
    const cols = parseIndexColumns(head);
    if (!cols || !cols.length) continue;
    if (isPk) pkCols.push(...cols);
    // 仅单列唯一索引才让列本身唯一（复合唯一不代表任一列单独唯一）。
    if (isUnique && cols.length === 1) uniqueCols.push(cols[0]);
  }
  return { pkCols, uniqueCols };
};

export const parseDBML = (dbml: string): ParseResult => {
  const tables: ParsedTable[] = [];
  const relationships: ParsedRelationship[] = [];
  const tableByName = new Map<string, ParsedTable>();

  const cleanSrc = stripDbmlComments(dbml);

  for (const stmt of tokenizeTopLevel(cleanSrc)) {
    if (stmt.kind === "table" && stmt.body !== null) {
      const head = parseTableHeader(stmt.header);
      if (!head) continue;
      const columns: ParsedColumn[] = [];
      const primaryKeys: string[] = [];
      const foreignKeys: ParsedForeignKey[] = [];
      // indexes 块抽取到的复合主键 / 单列唯一约束，循环结束后统一应用。
      const indexPkCols: string[] = [];
      const indexUniqueCols: string[] = [];

      for (const line of splitLogicalLines(stmt.body)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 跳过嵌套块 / 非列声明：
        //   Note { ... } / Note: '...'
        //   checks { ... }                    DBML 校验约束块
        //   records { ... } / records (cols) { ... }   插桩示例数据块
        //   ~partial_name                     TablePartial 注入；不展开，仅跳过
        // 不跳过会被 parseColumnLine 错认为以 `checks` / `records` 命名的列。
        // indexes { ... } 不再整体跳过 —— 复合主键 (a,b)[pk] / 唯一 col[unique]
        // 写在这里，对 ER 图的主键标记与 1:1 推断都有用。
        if (/^Note\s*[:{]/i.test(trimmed)) continue;
        if (/^indexes\s*\{/i.test(trimmed)) {
          const open = trimmed.indexOf("{");
          const close = findMatchingBrace(trimmed, open);
          if (open !== -1 && close !== -1) {
            const got = extractIndexesConstraints(trimmed.slice(open + 1, close));
            indexPkCols.push(...got.pkCols);
            indexUniqueCols.push(...got.uniqueCols);
          }
          continue;
        }
        if (/^checks\s*\{/i.test(trimmed)) continue;
        if (/^records\b/i.test(trimmed)) continue;
        if (trimmed.startsWith("~")) continue;

        const { column, inlineRef } = parseColumnLine(trimmed);
        if (!column) continue;
        if (column.isPrimaryKey) primaryKeys.push(column.name);
        if (inlineRef) {
          foreignKeys.push({
            column: column.name,
            referencedTable: inlineRef.target.table,
            referencedColumn: inlineRef.target.column,
          });
          const card = opToCardinality(inlineRef.op);
          relationships.push({
            from: head.name,
            to: inlineRef.target.table,
            label: column.name,
            fromCardinality: card.from,
            toCardinality: card.to,
          });
        }
        columns.push(column);
      }

      // 应用 indexes 块抽取的复合主键与单列唯一约束。
      for (const c of indexPkCols) {
        if (!primaryKeys.includes(c)) primaryKeys.push(c);
      }
      for (const c of indexUniqueCols) {
        const col = columns.find((x) => x.name === c);
        if (col && !col.isPrimaryKey) col.isUnique = true;
      }

      const tableNote = extractTableNote(stmt.body);
      const table: ParsedTable = {
        name: head.name,
        alias: head.alias,
        columns,
        primaryKeys,
        foreignKeys,
        ...(tableNote ? { comment: tableNote } : {}),
      };
      tables.push(table);
      tableByName.set(head.name, table);
      continue;
    }

    if (stmt.kind === "ref") {
      const colon = indexOfUnquoted(stmt.header, ":");
      if (colon === -1) continue;
      const ref = parseRefBody(stmt.header.slice(colon + 1));
      if (ref) addRelationship(ref, relationships, tableByName);
      continue;
    }

    if (stmt.kind === "refblock" && stmt.body !== null) {
      for (const line of splitLogicalLines(stmt.body)) {
        const ref = parseRefBody(line);
        if (ref) addRelationship(ref, relationships, tableByName);
      }
      continue;
    }
    // enum / project / tablegroup / unknown：忽略
  }

  // 基数推断：当关系是默认的 N:1（来自 `>` 或缺省），但 FK 列在 from 表上
  // 是单列主键或带 unique 约束时，把 from 端升级为 "1" —— 这才是 1:1。
  // 例：
  //   Table user_profiles { user_id bigint [pk, ref: > users.id] }   // 推断 1:1
  //   Table payments { order_id bigint [unique]; ... }
  //   Ref: payments.order_id > orders.id                              // 推断 1:1
  // 对显式写 `<` / `-` / `<>` 的关系不做改动，尊重作者意图。
  // label 含逗号说明是复合 FK，单列推断不适用，跳过。
  for (const rel of relationships) {
    if (rel.fromCardinality !== "N" || rel.toCardinality !== "1") continue;
    if (rel.label.includes(",")) continue;
    const fromTable = tableByName.get(rel.from);
    if (!fromTable) continue;
    const col = fromTable.columns.find((c) => c.name === rel.label);
    if (!col) continue;
    const isOnlySinglePk =
      fromTable.primaryKeys.length === 1 && fromTable.primaryKeys[0] === col.name;
    if (col.isUnique || isOnlySinglePk) {
      rel.fromCardinality = "1";
    }
  }

  return { tables, relationships };
};
