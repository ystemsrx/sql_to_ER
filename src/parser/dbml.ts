/**
 * DBML Parser
 *
 * 基于扫描器的实现：维护字符串字面量 / 花括号 / 方括号的状态，
 * 而不是堆叠正则。能稳定处理：
 *   - 字符串里出现的注释、括号、引号
 *   - 多行属性 [ ... ]、嵌套 Note { ... }、indexes { ... } 块
 *   - Ref 短语句、Ref 块（多条）、内联 ref 属性
 *   - 反引号 / 双引号 / 方括号 / 中文标识符
 *   - schema.table.column 的多段限定符（完整保留 table 的 schema；引号 / 括号感知，
 *     "my.table" 这种带点引用名整体保留，不被误拆）
 *   - 复合类型 decimal(10,2) / varchar(255)
 *   - 数组类型后缀 int[] / int[][] / decimal(10,2)[]（与列尾设置块 [...] 区分）
 *   - indexes { (a,b) [pk/unique] / col [unique] } 的复合候选键
 *   - TablePartial 递归注入、可选关系运算符与 Ref name/settings
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
  ParserWarning,
} from "../types";

// 裸词部分用 Unicode 属性类（\p{L}\p{N}\p{M}_$），日文假名 / 韩文谚文等
// 标识符同样有效；使用处构造 RegExp 时必须带 `u` flag。
// 注意不能用 String.raw：模板字面量里反引号必须写成 \`，raw 会把这个反斜杠
// 保留下来，而 u 模式下 \` 是非法转义。
const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[\\p{L}\\p{N}\\p{M}_$]+)';

// 标识符字符（与 IDENT 的裸词字符类保持一致），用于词边界判断。
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_$]/u;
// schema-qualified 标识符：a / a.b / a.b.c。每段都允许带引号 / 反引号 / 方括号。
const QUALIFIED_IDENT = String.raw`${IDENT}(?:\.${IDENT})*`;

// 去掉一段标识符外层的引号 / 反引号 / 方括号。
const stripOuterQuotes = (seg: string): string => seg.trim().replace(/^[`"\[]|[`"\]]$/g, "");

const linePrefix = (line: number | undefined): string => (line ? `line ${line}: ` : "");

const pushWarning = (
  warnings: ParserWarning[],
  code: ParserWarning["code"],
  line: number | undefined,
  detail: string,
): void => {
  warnings.push({
    code,
    message: `${linePrefix(line)}${detail}`,
    ...(line ? { line } : {}),
  });
};

const countNewlines = (s: string): number => (s.match(/\n/g) ?? []).length;

interface RelationshipTypeSignature {
  value: string;
  known: boolean;
}

const relationshipTypeSignature = (raw: string): RelationshipTypeSignature => {
  let normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const arrayMatch = normalized.match(/(?:\[\s*\])+\s*$/);
  const arrays = (arrayMatch?.[0] ?? "").replace(/\s+/g, "");
  if (arrayMatch) normalized = normalized.slice(0, -arrayMatch[0].length).trim();
  normalized = normalized
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const unsigned = /\bunsigned\b/.test(normalized);
  normalized = normalized
    .replace(/\b(?:unsigned|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const aliases: Record<string, string> = {
    int: "integer",
    int4: "integer",
    serial: "integer",
    int2: "smallint",
    smallserial: "smallint",
    int8: "bigint",
    bigserial: "bigint",
    dec: "decimal",
    "double precision": "double",
    float8: "double",
    float4: "real",
    "character varying": "varchar",
    nvarchar2: "nvarchar",
    varchar2: "varchar",
    "national character varying": "nvarchar",
    character: "char",
    "national character": "nchar",
    uniqueidentifier: "uuid",
    "timestamp with time zone": "timestamptz",
    "time with time zone": "timetz",
  };
  const base = aliases[normalized] ?? normalized;
  const value = `${base}${unsigned ? " unsigned" : ""}${arrays}`;
  const known = new Set([
    "tinyint",
    "smallint",
    "mediumint",
    "integer",
    "bigint",
    "decimal",
    "numeric",
    "real",
    "float",
    "double",
    "boolean",
    "bit",
    "char",
    "nchar",
    "varchar",
    "nvarchar",
    "text",
    "blob",
    "binary",
    "varbinary",
    "date",
    "time",
    "timetz",
    "datetime",
    "timestamp",
    "timestamptz",
    "uuid",
    "json",
    "jsonb",
    "xml",
  ]).has(base);
  return { value, known };
};

const relationshipTypesCompatible = (
  left: string,
  right: string,
): { compatible: boolean; uncertain: boolean } => {
  const a = relationshipTypeSignature(left);
  const b = relationshipTypeSignature(right);
  if (a.value === b.value) return { compatible: true, uncertain: false };
  return { compatible: false, uncertain: !a.known || !b.known };
};

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

// 表名需要保留全部 schema 段；列名 / alias 仍由 cleanIdentifier 读取单段。
const cleanQualifiedIdentifier = (raw: string): string =>
  splitQualified(raw).map(stripOuterQuotes).filter(Boolean).join(".");

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

const stripDbmlComments = (src: string, warnings: ParserWarning[]): string => {
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
      const commentStart = i;
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      } else {
        const line = 1 + (src.slice(0, commentStart).match(/\n/g) ?? []).length;
        pushWarning(warnings, "statement_skipped", line, "block comment was not closed");
      }
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

interface LogicalLine {
  text: string;
  line: number;
}

// 把表体拆成"逻辑行"：换行只在没有 [...] 或 { ... } 包裹时才是行边界。
const splitLogicalLineEntries = (body: string, startLine = 1): LogicalLine[] => {
  const lines: LogicalLine[] = [];
  let cur = "";
  let curLine = startLine;
  let line = startLine;
  let bracketDepth = 0;
  let braceDepth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipString(body, i);
      const chunk = body.slice(i, end);
      cur += chunk;
      line += countNewlines(chunk);
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
    if ((ch === "\n" || ch === ";") && bracketDepth <= 0 && braceDepth <= 0) {
      if (cur.trim()) lines.push({ text: cur, line: curLine });
      cur = "";
      if (ch === "\n") line++;
      curLine = line;
      i++;
      continue;
    }
    if (ch === "\n") line++;
    cur += ch;
    i++;
  }
  if (cur.trim()) lines.push({ text: cur, line: curLine });
  return lines;
};

const splitLogicalLines = (body: string): string[] =>
  splitLogicalLineEntries(body).map((entry) => entry.text);

interface RefTarget {
  table: string;
  column: string;
  columns: string[];
}

const parseRefTarget = (raw: string): RefTarget | null => {
  // 仅去掉首尾游离的逗号（来自 splitTopLevelCommas 拆开内联 ref 时残留）。
  // 不要再剥圆括号 —— 复合外键 `table.(col_a, col_b)` 的右括号会被误吃，
  // 历史上写过 `^[(,]|[),]$` 是按"防御性清洗"思路写的，现在已无必要。
  let cleaned = raw
    .trim()
    .replace(/^,+|,+$/g, "")
    .trim();
  if (!cleaned) return null;
  // 用引号 / 括号感知的切分：`"my.tbl".col` 取 my.tbl + col；
  // 复合列 `(a, b)` 保持完整不被 `.` 或逗号拆散。
  const rawSegments = splitQualified(cleaned);
  const segs = rawSegments.map(stripOuterQuotes).filter(Boolean);
  if (segs.length < 2) return null;
  // 复合列 `(col_a, col_b)` —— 去掉外层括号当作 label，避免出现 `(col_a, col_b)`
  // 这种带括号的边标签。table 与 column 仍按原始 segs 取，column 拿掉括号后
  // 用于显示。
  let column = segs[segs.length - 1];
  let columns = [column];
  const composite = rawSegments[rawSegments.length - 1].match(/^\(\s*([\s\S]+?)\s*\)$/);
  if (composite) {
    columns = splitTopLevelCommas(composite[1]).map(cleanIdentifier).filter(Boolean);
    column = columns.join(", ");
  }
  return { table: segs.slice(0, -1).join("."), column, columns };
};

const parseInlineRef = (refValue: string): { op: string; target: RefTarget } | null => {
  const m = refValue.match(/^\s*(\?>\?|\?<\?|\?>|>\?|\?<|<\?|<>|[<>\-])\s*(.+)$/);
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

const hasBalancedTypeDelimiters = (type: string): boolean => {
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
  };
  const closing = new Set(Object.values(pairs));
  const stack: string[] = [];
  let i = 0;
  while (i < type.length) {
    const ch = type[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(type, i);
      continue;
    }
    if (pairs[ch]) {
      stack.push(pairs[ch]);
    } else if (closing.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
    i++;
  }
  return stack.length === 0;
};

interface ColumnLineResult {
  column: ParsedColumn | null;
  inlineRef: { target: RefTarget; op: string } | null;
  malformedType?: boolean;
  badInlineRef?: boolean;
  unsupportedAttrs?: string[];
  trailingText?: string;
}

const readLeadingIdentifier = (line: string): string | null => {
  const m = line.trim().match(new RegExp(String.raw`^(${IDENT})(?:\s+|$)`, "u"));
  return m ? cleanIdentifier(m[1]) : null;
};

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
  const m = head.match(new RegExp(String.raw`^(${IDENT})\s+([\s\S]+)$`, "u"));
  if (!m) return { column: null, inlineRef: null };
  const name = cleanIdentifier(m[1]);
  const type = m[2].trim().replace(/\s+/g, " ");
  const malformedType = !hasBalancedTypeDelimiters(type);

  let isPrimaryKey = false;
  let isUnique = false;
  let inlineRef: ColumnLineResult["inlineRef"] = null;
  let badInlineRef = false;
  let comment: string | undefined;
  const unsupportedAttrs: string[] = [];

  if (attrsRaw) {
    for (const attr of parseColumnAttrs(attrsRaw)) {
      if (attr.key === "pk" || attr.key === "primary key") {
        isPrimaryKey = true;
      } else if (attr.key === "unique") {
        isUnique = true;
      } else if (attr.key === "ref") {
        const r = attr.value ? parseInlineRef(attr.value) : null;
        if (r) inlineRef = r;
        else badInlineRef = true;
      } else if (attr.key === "note" && attr.value) {
        comment = stripQuotes(attr.value);
      } else if (
        attr.key === "not null" ||
        attr.key === "null" ||
        attr.key === "increment" ||
        (attr.key === "default" && attr.value)
      ) {
        // 已识别、但不影响当前 ER 图结构的设置。
      } else {
        unsupportedAttrs.push(attr.key || "(empty)");
      }
    }
  }

  const trailingText = sb ? trimmed.slice(sb.rb + 1).trim() : "";

  const column: ParsedColumn = { name, type, isPrimaryKey };
  if (isUnique) column.isUnique = true;
  if (comment !== undefined) column.comment = comment;
  return {
    column,
    inlineRef,
    ...(malformedType ? { malformedType } : {}),
    ...(badInlineRef ? { badInlineRef } : {}),
    ...(unsupportedAttrs.length ? { unsupportedAttrs } : {}),
    ...(trailingText ? { trailingText } : {}),
  };
};

interface ParsedRefStatement {
  from: RefTarget;
  to: RefTarget;
  op: string;
  name?: string;
  inline?: boolean;
  comment?: string;
  onDelete?: string;
  onUpdate?: string;
  unsupportedSettings?: string[];
}

// Ref 顶层 settings 块 `[delete: cascade, note: 'xxx']` 中的 note 是关系注释。
// 拆出来：返回 (剥掉外层 [...] 后的 body, 提取到的 note 字符串)。
const stripRefSettings = (
  body: string,
): {
  body: string;
  comment?: string;
  onDelete?: string;
  onUpdate?: string;
  unsupportedSettings?: string[];
} => {
  let cleaned = body;
  let comment: string | undefined;
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  const unsupportedSettings: string[] = [];
  // 只把末尾、且含关系设置键的 `[...]` 当 settings；`table.[column]`
  // 是合法的方括号引用标识符，不能在这里剥掉。
  const lb = cleaned.lastIndexOf("[");
  if (lb !== -1) {
    const rb = findMatchingBracket(cleaned, lb);
    if (rb !== -1 && !cleaned.slice(rb + 1).trim()) {
      const inner = cleaned.slice(lb + 1, rb);
      // 注意 parseRefTarget 也会剥掉粘在右目标后面的 [...]；这里 stripRefSettings
      // 只是把"留在 body 里的 settings 文字"再抽一层 note 出来供关系节点显示。
      const attrs = parseColumnAttrs(inner);
      const recognized = attrs.some((attr) =>
        ["note", "delete", "update", "color"].includes(attr.key),
      );
      const isSettingsBlock = /\s/.test(cleaned[lb - 1] ?? "") || recognized;
      if (isSettingsBlock) {
        const referentialActions = new Set([
          "cascade",
          "restrict",
          "set null",
          "set default",
          "no action",
        ]);
        for (const attr of attrs) {
          if (attr.key === "note" && attr.value) {
            comment = stripQuotes(attr.value);
          } else if (attr.key === "delete" && attr.value) {
            const action = stripQuotes(attr.value).toLowerCase();
            if (referentialActions.has(action)) onDelete = action;
            else unsupportedSettings.push(`delete: ${action}`);
          } else if (attr.key === "update" && attr.value) {
            const action = stripQuotes(attr.value).toLowerCase();
            if (referentialActions.has(action)) onUpdate = action;
            else unsupportedSettings.push(`update: ${action}`);
          } else if (attr.key === "color" && attr.value) {
            // 已识别、但不影响当前 ER 图结构。
          } else {
            unsupportedSettings.push(attr.key || "(empty)");
          }
        }
        cleaned = cleaned.slice(0, lb).trim();
      }
    }
  }
  return {
    body: cleaned,
    ...(comment ? { comment } : {}),
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    ...(unsupportedSettings.length ? { unsupportedSettings } : {}),
  };
};

const parseRefBody = (rawBody: string): ParsedRefStatement | null => {
  const { body, comment, onDelete, onUpdate, unsupportedSettings } = stripRefSettings(rawBody);
  const operators = ["?>?", "?<?", "?>", ">?", "?<", "<?", "<>", "-", ">", "<"];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(body, i);
      continue;
    }
    const operator = operators.find((candidate) => body.startsWith(candidate, i));
    if (operator) {
      const left = body.slice(0, i).trim();
      const right = body.slice(i + operator.length).trim();
      const from = parseRefTarget(left);
      const to = parseRefTarget(right);
      if (from && to) {
        return {
          from,
          to,
          op: operator,
          ...(comment ? { comment } : {}),
          ...(onDelete ? { onDelete } : {}),
          ...(onUpdate ? { onUpdate } : {}),
          ...(unsupportedSettings?.length ? { unsupportedSettings } : {}),
        };
      }
    }
    i++;
  }
  return null;
};

interface TopStatement {
  kind:
    "table" | "tablepartial" | "ref" | "refblock" | "enum" | "project" | "tablegroup" | "unknown";
  header: string;
  body: string | null;
  line: number;
  bodyLine?: number;
}

const classifyHeader = (header: string): TopStatement["kind"] => {
  // 注意：先于 `Table\b` 判 TablePartial / TableGroup，否则前者会被吞。
  if (/^TablePartial\b/i.test(header)) return "tablepartial";
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
    const isWordBoundary = !prev || !WORD_CHAR_RE.test(prev);
    if (isWordBoundary && TOP_KEYWORD_RE.test(src.slice(i))) {
      return i;
    }
    i++;
  }
  return -1;
};

const tableNameFromHeader = (header: string): string | null => {
  const head = parseTableHeader(header);
  if (head) return head.name;
  const m = header.match(new RegExp(String.raw`^Table\s+(${QUALIFIED_IDENT})`, "iu"));
  return m ? cleanQualifiedIdentifier(m[1]) : null;
};

const tokenizeTopLevel = (src: string, warnings: ParserWarning[]): TopStatement[] => {
  const out: TopStatement[] = [];
  const n = src.length;

  // 预建换行位置表，行号用二分查找求得。旧实现每次 slice(0, index) 数换行是
  // O(n)，大文件（几百张表）上整个 tokenize 会退化成 O(n²)。
  const newlinePositions: number[] = [];
  for (let k = 0; k < n; k++) {
    if (src[k] === "\n") newlinePositions.push(k);
  }
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = newlinePositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlinePositions[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  const warnStrayLine = (header: string, startIdx: number): void => {
    const snippet = header.length > 48 ? `${header.slice(0, 48)}…` : header;
    pushWarning(
      warnings,
      "statement_skipped",
      lineAt(startIdx),
      `top-level line "${snippet}" was skipped because it is not a recognized statement`,
    );
  };

  let i = 0;
  while (i < n) {
    // 只跳过空白和可选分号。其它任何内容必须被切成一段并发出诊断，
    // 不能像旧实现一样直接跳到下一个已知关键字。
    while (i < n && (/\s/.test(src[i]) || src[i] === ";")) i++;
    if (i >= n) break;
    const startIdx = findNextKeyword(src, i);
    if (startIdx !== i) {
      const lineEndFound = src.indexOf("\n", i);
      const lineEnd = lineEndFound === -1 ? n : lineEndFound;
      const keywordBoundary = startIdx === -1 ? n : startIdx;
      const scanEnd = Math.min(lineEnd, keywordBoundary);
      let cursor = i;
      let unknownBrace = -1;
      while (cursor < scanEnd) {
        const ch = src[cursor];
        if (ch === "'" || ch === '"' || ch === "`") {
          cursor = skipString(src, cursor);
          continue;
        }
        if (ch === "{") {
          unknownBrace = cursor;
          break;
        }
        cursor++;
      }
      let end: number;
      if (unknownBrace !== -1) {
        const close = findMatchingBrace(src, unknownBrace);
        end = close === -1 ? n : close + 1;
      } else if (keywordBoundary < lineEnd) {
        end = keywordBoundary;
      } else {
        end = lineEnd;
      }
      const unknown = src.slice(i, end).trim();
      if (unknown) warnStrayLine(unknown.replace(/\s+/g, " "), i);
      i = end === lineEnd && end < n ? end + 1 : end;
      continue;
    }
    i = startIdx;

    let braceIdx = -1;
    let lineEndIdx = -1;
    let strayEndIdx = -1;
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
      if (ch === "\n" && bracketDepth === 0) {
        const head = src.slice(startIdx, j).trim();
        if (/^Ref\b[^{]*:/i.test(head)) {
          if (seenOperator) {
            lineEndIdx = j;
            break;
          }
          // 多行 Ref 短句：运算符尚未出现，继续扫描下一行。
        } else {
          // 非 Ref 头部遇到换行：只有下一个非空白字符是 '{'（块体换行开写）
          // 才继续；否则这是一条顶层散行（如 `Note: '...'`），按行截断，
          // 避免把下一个 Table 块整体吞成它的 body 而静默丢表。
          let k = j + 1;
          while (k < n && /\s/.test(src[k])) k++;
          if (src[k] !== "{") {
            strayEndIdx = j;
            break;
          }
        }
      }
      j++;
    }

    if (strayEndIdx !== -1) {
      warnStrayLine(src.slice(startIdx, strayEndIdx).trim(), startIdx);
      i = strayEndIdx + 1;
      continue;
    }

    if (braceIdx !== -1) {
      const header = src.slice(startIdx, braceIdx).trim();
      const closeIdx = findMatchingBrace(src, braceIdx);
      if (closeIdx === -1) {
        const kind = classifyHeader(header);
        if (kind === "table") {
          const tableName = tableNameFromHeader(header);
          pushWarning(
            warnings,
            "statement_skipped",
            lineAt(startIdx),
            tableName
              ? `Table "${tableName}" was skipped because its block is not closed`
              : "Table block was skipped because its block is not closed",
          );
        } else {
          pushWarning(
            warnings,
            "statement_skipped",
            lineAt(startIdx),
            `${header || "top-level"} block was skipped because it is not closed`,
          );
        }
        break;
      }
      const body = src.slice(braceIdx + 1, closeIdx);
      out.push({
        kind: classifyHeader(header),
        header,
        body,
        line: lineAt(startIdx),
        bodyLine: lineAt(braceIdx + 1),
      });
      i = closeIdx + 1;
      continue;
    }

    if (lineEndIdx !== -1) {
      const header = src.slice(startIdx, lineEndIdx).trim();
      if (header)
        out.push({
          kind: classifyHeader(header),
          header,
          body: null,
          line: lineAt(startIdx),
        });
      i = lineEndIdx + 1;
      continue;
    }

    // 文件尾部，无 '{'、无换行
    const header = src.slice(startIdx).trim();
    if (header) {
      const kind = classifyHeader(header);
      // 只有 Ref 短句能在无 body 的情况下被后续处理；其余头部在文件尾
      // 落单等同顶层散行，同样发警告。
      if (kind !== "ref") warnStrayLine(header, startIdx);
      out.push({
        kind,
        header,
        body: null,
        line: lineAt(startIdx),
      });
    }
    break;
  }
  return out;
};

const parseTableHeader = (
  header: string,
  warnings?: ParserWarning[],
  line?: number,
): { name: string; alias?: string; comment?: string } | null => {
  // 去掉头部 [headercolor: #abc] 之类的 settings
  let h = header;
  let comment: string | undefined;
  const lb = indexOfUnquoted(h, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(h, lb);
    if (rb !== -1) {
      for (const attr of parseColumnAttrs(h.slice(lb + 1, rb))) {
        if (attr.key === "note" && attr.value) {
          comment = stripQuotes(attr.value);
        } else if (attr.key === "headercolor" && attr.value) {
          // 已识别、但只影响 dbdiagram 的展示样式。
        } else if (warnings) {
          pushWarning(
            warnings,
            "statement_skipped",
            line,
            `table setting "${attr.key || "(empty)"}" was skipped`,
          );
        }
      }
      h = (h.slice(0, lb) + " " + h.slice(rb + 1)).trim();
    }
  }
  const m = h.match(
    new RegExp(String.raw`^Table\s+(${QUALIFIED_IDENT})(?:\s+as\s+(${IDENT}))?\s*$`, "iu"),
  );
  if (!m) return null;
  return {
    name: cleanQualifiedIdentifier(m[1]),
    alias: m[2] ? cleanIdentifier(m[2]) : undefined,
    ...(comment ? { comment } : {}),
  };
};

const parsePartialHeader = (header: string): string | null => {
  const m = header.match(
    new RegExp(String.raw`^TablePartial\s+(${QUALIFIED_IDENT})(?:\s+as\s+${IDENT})?\s*$`, "iu"),
  );
  return m ? cleanQualifiedIdentifier(m[1]) : null;
};

// DBML 关系运算符 → 两端基数。
//   `>`  many-to-one  (默认 FK 方向)
//   `<`  one-to-many
//   `-`  one-to-one
//   `<>` many-to-many
const opToCardinality = (
  op: string,
): { from: import("../types").Cardinality; to: import("../types").Cardinality } => {
  switch (op.replace(/\?/g, "")) {
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
    const segments = splitTopLevelCommas(inner);
    const identifier = new RegExp(String.raw`^${IDENT}$`, "u");
    if (
      segments.some((segment) => segment.trim().startsWith("`") || !identifier.test(segment.trim()))
    ) {
      return null;
    }
    return segments.map(cleanIdentifier).filter(Boolean);
  }
  if (!new RegExp(String.raw`^${IDENT}$`, "u").test(h)) return null;
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
  tableName?: string,
  warnings?: ParserWarning[],
  startLine = 1,
): { pkCols: string[]; uniqueCols: string[]; uniqueKeys: string[][] } => {
  const pkCols: string[] = [];
  const uniqueCols: string[] = [];
  const uniqueKeys: string[][] = [];
  for (const entry of splitLogicalLineEntries(blockBody, startLine)) {
    const line = entry.text.trim();
    if (!line) continue;
    const sb = findSettingsBracket(line);
    if (!sb) {
      if (line.includes("[") && warnings && tableName) {
        pushWarning(
          warnings,
          "constraint_skipped",
          entry.line,
          `index definition in table "${tableName}" has malformed settings`,
        );
      }
      continue; // 没有 [settings] -> 普通索引，不影响 ER 结构。
    }
    const head = line.slice(0, sb.lb).trim();
    let isPk = false;
    let isUnique = false;
    for (const attr of parseColumnAttrs(line.slice(sb.lb + 1, sb.rb))) {
      if (attr.key === "pk" || attr.key === "primary key") isPk = true;
      else if (attr.key === "unique") isUnique = true;
      else if ((attr.key === "name" || attr.key === "type") && attr.value) {
        // 已识别、但不影响当前 ER 图结构。
      } else if (warnings && tableName) {
        pushWarning(
          warnings,
          "constraint_skipped",
          entry.line,
          `index setting "${attr.key || "(empty)"}" in table "${tableName}" was skipped`,
        );
      }
    }
    if (!isPk && !isUnique) continue;
    const cols = parseIndexColumns(head);
    if (!cols || !cols.length) {
      if (warnings && tableName) {
        pushWarning(
          warnings,
          "constraint_skipped",
          entry.line,
          `index expression in table "${tableName}" was skipped`,
        );
      }
      continue;
    }
    if (isPk) pkCols.push(...cols);
    if (isUnique) uniqueKeys.push(cols);
    // 仅单列唯一索引才让列本身唯一（复合唯一不代表任一列单独唯一）。
    if (isUnique && cols.length === 1) uniqueCols.push(cols[0]);
  }
  return { pkCols, uniqueCols, uniqueKeys };
};

interface DbmlInlineRef {
  column: string;
  target: RefTarget;
  op: string;
  line: number;
}

interface DbmlInjection {
  name: string;
  line: number;
}

interface DbmlBodyDefinition {
  columns: ParsedColumn[];
  primaryKeys: string[];
  uniqueKeys: string[][];
  inlineRefs: DbmlInlineRef[];
  injections: DbmlInjection[];
  comment?: string;
}

const parseDbmlBody = (
  body: string,
  ownerName: string,
  startLine: number,
  warnings: ParserWarning[],
): DbmlBodyDefinition => {
  const columns: ParsedColumn[] = [];
  const primaryKeys: string[] = [];
  const uniqueKeys: string[][] = [];
  const inlineRefs: DbmlInlineRef[] = [];
  const injections: DbmlInjection[] = [];

  for (const entry of splitLogicalLineEntries(body, startLine)) {
    const trimmed = entry.text.trim();
    if (!trimmed || /^Note\s*[:{]/i.test(trimmed)) continue;
    if (/^indexes\s*\{/i.test(trimmed)) {
      const open = trimmed.indexOf("{");
      const close = findMatchingBrace(trimmed, open);
      if (open !== -1 && close !== -1) {
        const got = extractIndexesConstraints(
          trimmed.slice(open + 1, close),
          ownerName,
          warnings,
          entry.line + countNewlines(trimmed.slice(0, open + 1)),
        );
        for (const column of got.pkCols) {
          if (!primaryKeys.includes(column)) primaryKeys.push(column);
        }
        for (const key of got.uniqueKeys) uniqueKeys.push([...key]);
        for (const uniqueColumn of got.uniqueCols) {
          const column = columns.find((item) => item.name === uniqueColumn);
          if (column && !column.isPrimaryKey) column.isUnique = true;
        }
      }
      continue;
    }
    if (/^checks\s*\{/i.test(trimmed)) {
      pushWarning(
        warnings,
        "constraint_skipped",
        entry.line,
        `checks block in table "${ownerName}" was skipped`,
      );
      continue;
    }
    if (/^records\b/i.test(trimmed)) continue;
    if (trimmed.startsWith("~")) {
      const name = cleanQualifiedIdentifier(trimmed.slice(1).trim());
      if (name) injections.push({ name, line: entry.line });
      else {
        pushWarning(
          warnings,
          "statement_skipped",
          entry.line,
          `table partial "${trimmed}" in table "${ownerName}" was skipped`,
        );
      }
      continue;
    }

    const { column, inlineRef, malformedType, badInlineRef, unsupportedAttrs, trailingText } =
      parseColumnLine(trimmed);
    if (!column) {
      const missingTypeName = readLeadingIdentifier(trimmed);
      pushWarning(
        warnings,
        missingTypeName ? "column_type_missing" : "statement_skipped",
        entry.line,
        missingTypeName
          ? `column "${missingTypeName}" in table "${ownerName}" has no type`
          : `line in table "${ownerName}" was not recognized`,
      );
      continue;
    }
    if (malformedType) {
      pushWarning(
        warnings,
        "column_type_invalid",
        entry.line,
        `column "${column.name}" in table "${ownerName}" has malformed type "${column.type}"`,
      );
    }
    if (badInlineRef) {
      pushWarning(
        warnings,
        "foreign_key_unrecognized",
        entry.line,
        `inline ref in column "${column.name}" of table "${ownerName}" was not recognized`,
      );
    }
    for (const attr of unsupportedAttrs ?? []) {
      pushWarning(
        warnings,
        "statement_skipped",
        entry.line,
        `column setting "${attr}" on "${column.name}" in table "${ownerName}" was skipped`,
      );
    }
    if (trailingText) {
      pushWarning(
        warnings,
        "statement_skipped",
        entry.line,
        `trailing content "${trailingText}" on column "${column.name}" in table "${ownerName}" was skipped`,
      );
    }
    if (column.isPrimaryKey && !primaryKeys.includes(column.name)) primaryKeys.push(column.name);
    if (column.isUnique) uniqueKeys.push([column.name]);
    if (inlineRef) {
      inlineRefs.push({
        column: column.name,
        target: inlineRef.target,
        op: inlineRef.op,
        line: entry.line,
      });
    }
    columns.push(column);
  }

  for (const primaryKey of primaryKeys) {
    const column = columns.find((item) => item.name === primaryKey);
    if (column) column.isPrimaryKey = true;
  }
  for (const key of uniqueKeys) {
    if (key.length !== 1) continue;
    const column = columns.find((item) => item.name === key[0]);
    if (column && !column.isPrimaryKey) column.isUnique = true;
  }

  const comment = extractTableNote(body);
  return {
    columns,
    primaryKeys,
    uniqueKeys,
    inlineRefs,
    injections,
    ...(comment ? { comment } : {}),
  };
};

export const parseDBML = (dbml: string): ParseResult => {
  const tables: ParsedTable[] = [];
  const relationships: ParsedRelationship[] = [];
  const warnings: ParserWarning[] = [];
  const cleanSrc = stripDbmlComments(dbml, warnings);
  const statements = tokenizeTopLevel(cleanSrc, warnings);
  const candidateKeys = new WeakMap<ParsedTable, string[][]>();

  interface PartialDefinition extends DbmlBodyDefinition {
    name: string;
    line: number;
  }
  interface RefRecord {
    ref: ParsedRefStatement;
    line: number;
  }

  const partials: PartialDefinition[] = [];
  const refRecords: RefRecord[] = [];

  // TablePartial 先建立符号表，允许表和 partial 引用后置定义。
  for (const stmt of statements) {
    if (stmt.kind !== "tablepartial" || stmt.body === null) continue;
    const name = parsePartialHeader(stmt.header);
    if (!name) {
      pushWarning(
        warnings,
        "statement_skipped",
        stmt.line,
        "table partial definition was skipped because its name was not recognized",
      );
      continue;
    }
    partials.push({
      name,
      line: stmt.line,
      ...parseDbmlBody(stmt.body, name, stmt.bodyLine ?? stmt.line, warnings),
    });
  }

  const sameName = (left: string, right: string): boolean =>
    left === right || left.toLowerCase() === right.toLowerCase();
  const shortName = (name: string): string => {
    const parts = name.split(".");
    return parts[parts.length - 1] || name;
  };
  const cloneBody = (body: DbmlBodyDefinition): DbmlBodyDefinition => ({
    columns: body.columns.map((column) => ({ ...column })),
    primaryKeys: [...body.primaryKeys],
    uniqueKeys: body.uniqueKeys.map((key) => [...key]),
    inlineRefs: body.inlineRefs.map((ref) => ({
      ...ref,
      target: { ...ref.target, columns: [...ref.target.columns] },
    })),
    injections: body.injections.map((injection) => ({ ...injection })),
    ...(body.comment ? { comment: body.comment } : {}),
  });

  const mergeBodies = (
    injected: DbmlBodyDefinition[],
    local: DbmlBodyDefinition,
  ): DbmlBodyDefinition => {
    const merged: DbmlBodyDefinition = {
      columns: [],
      primaryKeys: [],
      uniqueKeys: [],
      inlineRefs: [],
      injections: [],
    };
    const addConstraintMembers = (body: DbmlBodyDefinition): void => {
      for (const primaryKey of body.primaryKeys) {
        if (!merged.primaryKeys.some((name) => sameName(name, primaryKey))) {
          merged.primaryKeys.push(primaryKey);
        }
      }
      for (const key of body.uniqueKeys) {
        const signature = [...key]
          .map((name) => name.toLowerCase())
          .sort()
          .join("\u0000");
        if (
          !merged.uniqueKeys.some(
            (candidate) =>
              [...candidate]
                .map((name) => name.toLowerCase())
                .sort()
                .join("\u0000") === signature,
          )
        ) {
          merged.uniqueKeys.push([...key]);
        }
      }
      merged.inlineRefs.push(...cloneBody(body).inlineRefs);
      if (!merged.comment && body.comment) merged.comment = body.comment;
    };

    for (const body of injected) {
      for (const column of body.columns) {
        if (!merged.columns.some((item) => sameName(item.name, column.name))) {
          merged.columns.push({ ...column });
        }
      }
      addConstraintMembers(body);
    }
    // Partial 字段先注入；同名本地字段删除注入版本并按本地声明位置重新加入。
    for (const column of local.columns) {
      merged.columns = merged.columns.filter((item) => !sameName(item.name, column.name));
      merged.columns.push({ ...column });
    }
    addConstraintMembers(local);
    if (local.comment) merged.comment = local.comment;

    for (const primaryKey of merged.primaryKeys) {
      const column = merged.columns.find((item) => sameName(item.name, primaryKey));
      if (column) column.isPrimaryKey = true;
    }
    for (const key of merged.uniqueKeys) {
      if (key.length !== 1) continue;
      const column = merged.columns.find((item) => sameName(item.name, key[0]));
      if (column && !column.isPrimaryKey) column.isUnique = true;
    }
    return merged;
  };

  const resolvePartial = (name: string): { partial?: PartialDefinition; ambiguous?: boolean } => {
    const exact = partials.filter((partial) => sameName(partial.name, name));
    if (exact.length === 1) return { partial: exact[0] };
    if (exact.length > 1) return { ambiguous: true };
    const short = shortName(name).toLowerCase();
    const matches = partials.filter((partial) => shortName(partial.name).toLowerCase() === short);
    if (matches.length === 1) return { partial: matches[0] };
    return matches.length > 1 ? { ambiguous: true } : {};
  };

  const partialCache = new Map<PartialDefinition, DbmlBodyDefinition>();
  const resolvingPartials = new Set<PartialDefinition>();
  const warnedCycles = new Set<string>();
  const expandPartial = (partial: PartialDefinition): DbmlBodyDefinition => {
    const cached = partialCache.get(partial);
    if (cached) return cloneBody(cached);
    if (resolvingPartials.has(partial)) {
      if (!warnedCycles.has(partial.name)) {
        warnedCycles.add(partial.name);
        pushWarning(
          warnings,
          "constraint_skipped",
          partial.line,
          `table partial cycle involving "${partial.name}" was skipped`,
        );
      }
      return {
        columns: [],
        primaryKeys: [],
        uniqueKeys: [],
        inlineRefs: [],
        injections: [],
      };
    }
    resolvingPartials.add(partial);
    const injected: DbmlBodyDefinition[] = [];
    for (const injection of partial.injections) {
      const resolution = resolvePartial(injection.name);
      if (resolution.partial) injected.push(expandPartial(resolution.partial));
      else {
        pushWarning(
          warnings,
          "statement_skipped",
          injection.line,
          resolution.ambiguous
            ? `table partial "~${injection.name}" in table "${partial.name}" was skipped because it is ambiguous`
            : `table partial "~${injection.name}" in table "${partial.name}" was skipped`,
        );
      }
    }
    const expanded = mergeBodies(injected, partial);
    resolvingPartials.delete(partial);
    partialCache.set(partial, expanded);
    return cloneBody(expanded);
  };

  const expandTableBody = (tableName: string, local: DbmlBodyDefinition): DbmlBodyDefinition => {
    const injected: DbmlBodyDefinition[] = [];
    for (const injection of local.injections) {
      const resolution = resolvePartial(injection.name);
      if (resolution.partial) injected.push(expandPartial(resolution.partial));
      else {
        pushWarning(
          warnings,
          "statement_skipped",
          injection.line,
          resolution.ambiguous
            ? `table partial "~${injection.name}" in table "${tableName}" was skipped because it is ambiguous`
            : `table partial "~${injection.name}" in table "${tableName}" was skipped`,
        );
      }
    }
    return mergeBodies(injected, local);
  };

  const definedTableNames = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind === "table" && stmt.body !== null) {
      const head = parseTableHeader(stmt.header, warnings, stmt.line);
      if (!head) {
        pushWarning(
          warnings,
          "statement_skipped",
          stmt.line,
          "table definition was skipped because the table name was not recognized",
        );
        continue;
      }
      const local = parseDbmlBody(stmt.body, head.name, stmt.bodyLine ?? stmt.line, warnings);
      const body = expandTableBody(head.name, local);
      const seenColumns = new Set<string>();
      for (const column of body.columns) {
        const key = column.name.toLowerCase();
        if (seenColumns.has(key)) {
          pushWarning(
            warnings,
            "statement_skipped",
            stmt.line,
            `column "${column.name}" is defined more than once in table "${head.name}"`,
          );
        }
        seenColumns.add(key);
      }
      body.primaryKeys = body.primaryKeys.filter((name) => {
        if (body.columns.some((column) => sameName(column.name, name))) return true;
        pushWarning(
          warnings,
          "constraint_skipped",
          stmt.line,
          `primary key on table "${head.name}" references missing column "${name}"`,
        );
        return false;
      });
      body.uniqueKeys = body.uniqueKeys.filter((key) => {
        const missing = key.filter(
          (name) => !body.columns.some((column) => sameName(column.name, name)),
        );
        if (!missing.length) return true;
        pushWarning(
          warnings,
          "constraint_skipped",
          stmt.line,
          `unique constraint on table "${head.name}" references missing column${missing.length > 1 ? "s" : ""} "${missing.join('", "')}"`,
        );
        return false;
      });
      body.inlineRefs = body.inlineRefs.filter((ref) => {
        if (body.columns.some((column) => sameName(column.name, ref.column))) return true;
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          ref.line,
          `inline Ref in table "${head.name}" references missing local column "${ref.column}"`,
        );
        return false;
      });
      if (!body.columns.length) {
        pushWarning(
          warnings,
          "statement_skipped",
          stmt.line,
          `Table "${head.name}" produced no supported columns`,
        );
      }
      const table: ParsedTable = {
        name: head.name,
        alias: head.alias,
        columns: body.columns,
        primaryKeys: body.primaryKeys,
        foreignKeys: [],
        ...(head.comment || body.comment ? { comment: head.comment ?? body.comment } : {}),
      };
      const tableKey = table.name.toLowerCase();
      if (definedTableNames.has(tableKey)) {
        pushWarning(
          warnings,
          "duplicate_table",
          stmt.line,
          `table "${table.name}" is defined more than once`,
        );
      }
      definedTableNames.add(tableKey);
      tables.push(table);
      const keys: string[][] = [];
      if (table.primaryKeys.length) keys.push([...table.primaryKeys]);
      for (const key of body.uniqueKeys) keys.push([...key]);
      candidateKeys.set(table, keys);
      for (const inline of body.inlineRefs) {
        refRecords.push({
          ref: {
            from: {
              table: table.name,
              column: inline.column,
              columns: [inline.column],
            },
            to: inline.target,
            op: inline.op,
            inline: true,
          },
          line: inline.line,
        });
      }
      continue;
    }

    if (stmt.kind === "unknown") {
      // 无 body 的散行已经在 tokenizeTopLevel 中报告；带 body 的未知构造在此
      // 统一报告，确保 DiagramView / Note / records 等不会静默消失。
      if (stmt.body !== null) {
        const compact = stmt.header.replace(/\s+/g, " ").trim();
        pushWarning(
          warnings,
          "statement_skipped",
          stmt.line,
          `top-level block "${compact}" was skipped because it is not supported`,
        );
      }
      continue;
    }

    if (stmt.kind === "ref") {
      const colon = indexOfUnquoted(stmt.header, ":");
      if (colon === -1) continue;
      const prefix = stmt.header.slice(0, colon).trim();
      const nameMatch = prefix.match(/^Ref(?:\s+(.+?))?$/i);
      const ref = parseRefBody(stmt.header.slice(colon + 1));
      if (ref) {
        if (nameMatch?.[1]) ref.name = cleanIdentifier(nameMatch[1]);
        refRecords.push({ ref, line: stmt.line });
      } else {
        pushWarning(
          warnings,
          "foreign_key_unrecognized",
          stmt.line,
          "ref statement was not recognized",
        );
      }
      continue;
    }

    if (stmt.kind === "refblock" && stmt.body !== null) {
      const nameMatch = stmt.header.trim().match(/^Ref(?:\s+(.+?))?$/i);
      for (const entry of splitLogicalLineEntries(stmt.body, stmt.bodyLine ?? stmt.line)) {
        const ref = parseRefBody(entry.text);
        if (ref) {
          if (nameMatch?.[1]) ref.name = cleanIdentifier(nameMatch[1]);
          refRecords.push({ ref, line: entry.line });
        } else {
          pushWarning(
            warnings,
            "foreign_key_unrecognized",
            entry.line,
            "ref statement was not recognized",
          );
        }
      }
    }
  }

  interface TableResolution {
    table?: ParsedTable;
    ambiguous?: boolean;
  }
  const resolveTable = (rawName: string, context?: ParsedTable): TableResolution => {
    const exact = tables.filter((table) => sameName(table.name, rawName));
    if (exact.length === 1) return { table: exact[0] };
    if (exact.length > 1) return { ambiguous: true };

    const aliases = tables.filter((table) => table.alias && sameName(table.alias, rawName));
    if (aliases.length === 1) return { table: aliases[0] };
    if (aliases.length > 1) return { ambiguous: true };

    const qualified = rawName.includes(".");
    if (!qualified && context?.name.includes(".")) {
      const schema = context.name.slice(0, context.name.lastIndexOf("."));
      const contextual = `${schema}.${rawName}`;
      const matches = tables.filter((table) => sameName(table.name, contextual));
      if (matches.length === 1) return { table: matches[0] };
      if (matches.length > 1) return { ambiguous: true };
    }

    const short = shortName(rawName).toLowerCase();
    const candidates = tables.filter((table) => {
      if (qualified && table.name.includes(".")) return false;
      return shortName(table.name).toLowerCase() === short;
    });
    if (candidates.length === 1) return { table: candidates[0] };
    return candidates.length > 1 ? { ambiguous: true } : {};
  };

  const hasExactCandidateKey = (table: ParsedTable, columns: string[]): boolean => {
    const signature = [...columns]
      .map((name) => name.toLowerCase())
      .sort()
      .join("\u0000");
    return (candidateKeys.get(table) ?? []).some(
      (key) =>
        [...key]
          .map((name) => name.toLowerCase())
          .sort()
          .join("\u0000") === signature,
    );
  };
  for (const { ref, line } of refRecords) {
    for (const setting of ref.unsupportedSettings ?? []) {
      pushWarning(warnings, "statement_skipped", line, `Ref setting "${setting}" was skipped`);
    }
    let fromResolution = resolveTable(ref.from.table);
    let toResolution = resolveTable(ref.to.table);
    if (toResolution.table && !fromResolution.table) {
      fromResolution = resolveTable(ref.from.table, toResolution.table);
    }
    if (fromResolution.table && !toResolution.table) {
      toResolution = resolveTable(ref.to.table, fromResolution.table);
    }
    if (fromResolution.ambiguous || toResolution.ambiguous) {
      const ambiguousName = fromResolution.ambiguous ? ref.from.table : ref.to.table;
      pushWarning(
        warnings,
        "table_reference_missing",
        line,
        `Ref references ambiguous table "${ambiguousName}"`,
      );
      continue;
    }

    const fromTable = fromResolution.table;
    const toTable = toResolution.table;
    if (!fromTable) {
      pushWarning(
        warnings,
        "table_reference_missing",
        line,
        `Ref references missing table "${ref.from.table}"`,
      );
    }
    if (!toTable) {
      pushWarning(
        warnings,
        "table_reference_missing",
        line,
        `Ref references missing table "${ref.to.table}"`,
      );
    }
    if (ref.from.columns.length !== ref.to.columns.length) {
      pushWarning(
        warnings,
        "foreign_key_unrecognized",
        line,
        "Ref has mismatched endpoint column counts",
      );
      continue;
    }

    const findColumn = (table: ParsedTable | undefined, name: string): ParsedColumn | undefined =>
      table?.columns.find((column) => sameName(column.name, name));
    const missingFromColumns = fromTable
      ? ref.from.columns.filter((name) => !findColumn(fromTable, name))
      : [];
    const missingToColumns = toTable
      ? ref.to.columns.filter((name) => !findColumn(toTable, name))
      : [];
    if (missingFromColumns.length) {
      pushWarning(
        warnings,
        "foreign_key_unrecognized",
        line,
        `Ref references missing column${missingFromColumns.length > 1 ? "s" : ""} "${missingFromColumns.join('", "')}" in table "${fromTable?.name}"`,
      );
    }
    if (missingToColumns.length) {
      pushWarning(
        warnings,
        "foreign_key_unrecognized",
        line,
        `Ref references missing column${missingToColumns.length > 1 ? "s" : ""} "${missingToColumns.join('", "')}" in table "${toTable?.name}"`,
      );
    }

    const baseOperator = ref.op.replace(/\?/g, "");
    const card = opToCardinality(baseOperator);
    const holderSide = ref.inline
      ? "from"
      : baseOperator === ">"
        ? "from"
        : baseOperator === "<" || baseOperator === "-"
          ? "to"
          : null;
    const holderEndpoint = holderSide === "to" ? ref.to : ref.from;
    const holderTable = holderSide === "to" ? toTable : fromTable;
    const targetEndpoint = holderSide === "to" ? ref.from : ref.to;
    const targetTable = holderSide === "to" ? fromTable : toTable;
    if (
      holderSide &&
      targetTable &&
      targetEndpoint.columns.every((name) => !!findColumn(targetTable, name)) &&
      !hasExactCandidateKey(targetTable, targetEndpoint.columns)
    ) {
      pushWarning(
        warnings,
        "foreign_key_unrecognized",
        line,
        `Ref target columns in table "${targetTable.name}" are not a primary or unique key`,
      );
    }

    if (fromTable && toTable && !missingFromColumns.length && !missingToColumns.length) {
      for (let i = 0; i < ref.from.columns.length; i++) {
        const fromColumn = findColumn(fromTable, ref.from.columns[i]);
        const toColumn = findColumn(toTable, ref.to.columns[i]);
        if (!fromColumn?.type || !toColumn?.type) continue;
        const compatibility = relationshipTypesCompatible(fromColumn.type, toColumn.type);
        if (!compatibility.compatible) {
          pushWarning(
            warnings,
            "foreign_key_unrecognized",
            line,
            compatibility.uncertain
              ? `Ref column types "${fromColumn.type}" and "${toColumn.type}" could not be verified as compatible`
              : `Ref column types "${fromColumn.type}" and "${toColumn.type}" are incompatible`,
          );
        }
      }
    }
    let fromCardinality = card.from;
    let toCardinality = card.to;
    if (baseOperator === ">" && fromTable && hasExactCandidateKey(fromTable, ref.from.columns)) {
      fromCardinality = "1";
    }

    const relationship: ParsedRelationship = {
      from: fromTable?.name ?? ref.from.table,
      to: toTable?.name ?? ref.to.table,
      label: holderEndpoint.column,
      fromCardinality,
      toCardinality,
      ...(ref.op.startsWith("?") ? { fromOptional: true } : {}),
      ...(ref.op.endsWith("?") ? { toOptional: true } : {}),
      ...(ref.name ? { name: ref.name } : {}),
      ...(ref.onDelete ? { onDelete: ref.onDelete } : {}),
      ...(ref.onUpdate ? { onUpdate: ref.onUpdate } : {}),
      ...(ref.comment ? { comment: ref.comment } : {}),
    };
    relationships.push(relationship);

    if (holderSide && holderTable) {
      holderTable.foreignKeys.push({
        column: holderEndpoint.column,
        referencedTable: targetTable?.name ?? targetEndpoint.table,
        referencedColumn: targetEndpoint.column,
      });
    }
  }

  return { tables, relationships, ...(warnings.length ? { warnings } : {}) };
};
