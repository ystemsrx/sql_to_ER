/**
 * DBML Parser
 *
 * 基于扫描器的实现：维护字符串字面量 / 花括号 / 方括号的状态，
 * 而不是堆叠正则。能稳定处理：
 *   - 字符串里出现的注释、括号、引号
 *   - 多行属性 [ ... ]、嵌套 Note { ... }、indexes { ... } 块
 *   - Ref 短语句、Ref 块（多条）、内联 ref 属性
 *   - 反引号 / 双引号 / 方括号 / 中文标识符
 *   - schema.table.column 的多段限定符（取最后两段）
 *   - 复合类型 decimal(10,2) / varchar(255)
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
} from "../types";

const IDENT = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w一-龥]+)`;

const cleanIdentifier = (raw: string): string => {
  const last = raw
    .split(".")
    .map((p) => p.trim().replace(/^[`"\[]|[`"\]]$/g, ""))
    .filter(Boolean)
    .pop();
  return last ?? raw.trim();
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
    while (
      j < src.length &&
      !(src[j] === "'" && src[j + 1] === "'" && src[j + 2] === "'")
    ) {
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
  const cleaned = raw.trim().replace(/^[(,]|[),]$/g, "");
  if (!cleaned) return null;
  const segs = cleaned
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^[`"\[]|[`"\]]$/g, ""));
  if (segs.length < 2) return null;
  return { table: segs[segs.length - 2], column: segs[segs.length - 1] };
};

const parseInlineRef = (
  refValue: string,
): { op: string; target: RefTarget } | null => {
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

const parseColumnLine = (line: string): ColumnLineResult => {
  const trimmed = line.trim();
  // 头部 = 'name type'，尾部可选 [attrs]
  const lb = indexOfUnquoted(trimmed, "[");
  let head: string;
  let attrsRaw = "";
  if (lb !== -1) {
    const rb = findMatchingBracket(trimmed, lb);
    head = trimmed.slice(0, lb).trim();
    if (rb !== -1) attrsRaw = trimmed.slice(lb + 1, rb);
  } else {
    head = trimmed;
  }
  const m = head.match(new RegExp(String.raw`^(${IDENT})\s+([\s\S]+)$`));
  if (!m) return { column: null, inlineRef: null };
  const name = cleanIdentifier(m[1]);
  const type = m[2].trim().replace(/\s+/g, " ");

  let isPrimaryKey = false;
  let inlineRef: ColumnLineResult["inlineRef"] = null;
  let comment: string | undefined;

  if (attrsRaw) {
    for (const attr of parseColumnAttrs(attrsRaw)) {
      if (attr.key === "pk" || attr.key === "primary key") {
        isPrimaryKey = true;
      } else if (attr.key === "ref" && attr.value) {
        const r = parseInlineRef(attr.value);
        if (r) inlineRef = r;
      } else if (attr.key === "note" && attr.value) {
        comment = stripQuotes(attr.value);
      }
    }
  }

  const column: ParsedColumn = { name, type, isPrimaryKey };
  if (comment !== undefined) column.comment = comment;
  return { column, inlineRef };
};

interface ParsedRefStatement {
  from: RefTarget;
  to: RefTarget;
  op: string;
}

const parseRefBody = (body: string): ParsedRefStatement | null => {
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
      return from && to ? { from, to, op: "<>" } : null;
    }
    if (ch === "<" || ch === ">" || ch === "-") {
      const left = body.slice(0, i).trim();
      const right = body.slice(i + 1).trim();
      const from = parseRefTarget(left);
      const to = parseRefTarget(right);
      if (from && to) return { from, to, op: ch };
    }
    i++;
  }
  return null;
};

interface TopStatement {
  kind:
    | "table"
    | "ref"
    | "refblock"
    | "enum"
    | "project"
    | "tablegroup"
    | "unknown";
  header: string;
  body: string | null;
}

const classifyHeader = (header: string): TopStatement["kind"] => {
  if (/^Table\b/i.test(header)) return "table";
  if (/^Ref\b\s*(?:[\w一-龥]+\s*)?:/i.test(header)) return "ref";
  if (/^Ref\b/i.test(header)) return "refblock";
  if (/^Enum\b/i.test(header)) return "enum";
  if (/^Project\b/i.test(header)) return "project";
  if (/^TableGroup\b/i.test(header)) return "tablegroup";
  return "unknown";
};

const TOP_KEYWORD_RE = /^(Table|Ref|Project|Enum|TableGroup)\b/i;

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
    let j = i;
    while (j < n) {
      const ch = src[j];
      if (ch === "'" || ch === '"' || ch === "`") {
        j = skipString(src, j);
        continue;
      }
      if (ch === "{") {
        braceIdx = j;
        break;
      }
      if (ch === "\n") {
        const head = src.slice(startIdx, j).trim();
        // Ref 短语句没有块；遇到换行就到此为止
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

const parseTableHeader = (
  header: string,
): { name: string; alias?: string } | null => {
  // 去掉头部 [headercolor: #abc] 之类的 settings
  let h = header;
  const lb = indexOfUnquoted(h, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(h, lb);
    if (rb !== -1) h = (h.slice(0, lb) + " " + h.slice(rb + 1)).trim();
  }
  const m = h.match(
    new RegExp(
      String.raw`^Table\s+(${IDENT})(?:\s+as\s+(${IDENT}))?\s*$`,
      "i",
    ),
  );
  if (!m) return null;
  return {
    name: cleanIdentifier(m[1]),
    alias: m[2] ? cleanIdentifier(m[2]) : undefined,
  };
};

const addRelationship = (
  ref: ParsedRefStatement,
  relationships: ParsedRelationship[],
  tableByName: Map<string, ParsedTable>,
): void => {
  relationships.push({
    from: ref.from.table,
    to: ref.to.table,
    label: ref.from.column,
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

      for (const line of splitLogicalLines(stmt.body)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 跳过嵌套块：Note { ... } / Note: '...' / indexes { ... }
        if (/^Note\s*[:{]/i.test(trimmed)) continue;
        if (/^indexes\s*\{/i.test(trimmed)) continue;

        const { column, inlineRef } = parseColumnLine(trimmed);
        if (!column) continue;
        if (column.isPrimaryKey) primaryKeys.push(column.name);
        if (inlineRef) {
          foreignKeys.push({
            column: column.name,
            referencedTable: inlineRef.target.table,
            referencedColumn: inlineRef.target.column,
          });
          relationships.push({
            from: head.name,
            to: inlineRef.target.table,
            label: column.name,
          });
        }
        columns.push(column);
      }

      const table: ParsedTable = {
        name: head.name,
        alias: head.alias,
        columns,
        primaryKeys,
        foreignKeys,
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

  return { tables, relationships };
};
