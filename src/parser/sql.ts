/**
 * SQL Parser - 解析 CREATE TABLE 语句
 *
 * 基于词法分析器（tokenizer）的实现，而不是堆叠正则。关键设计：
 *   1. 先把源码里的注释（`--` / `#` / `/* *\/`）替换成等长空白（保留偏移），
 *      字符串字面量 / 反引号 / 双引号 / 方括号 / dollar-quote 原样保留。
 *      => 反引号 / 方括号标识符里的 `-- ; ( ) ,` 不再破坏切分。
 *   2. 把语句切成 token 流：字符串与引用标识符都是“原子 token”，
 *      因此任何分隔符 / 关键字出现在字符串或引用标识符内部都不会泄漏出来。
 *      => DEFAULT 'PRIMARY KEY' / COMMENT 'must be UNIQUE' 不再误判。
 *   3. 关键字（CREATE / PRIMARY / KEY / REFERENCES ...）只在裸词 token 上匹配，
 *      引用标识符（`"select"` / `` `key` `` / `[key]`）永远不会被当成关键字。
 *      => 引用的保留字列名稳定；列 vs 约束的判定按“第二个 token”精确区分。
 *   4. 类型字符串通过 token 的源码偏移切片得到，保留原始书写（`DECIMAL(10, 2)`）。
 *
 * 语句覆盖：CREATE [OR REPLACE] [TEMP/...] TABLE、CREATE TABLE ... LIKE、
 * ALTER TABLE ... ADD COLUMN / PRIMARY KEY / UNIQUE / FOREIGN KEY（把新增的列 /
 * 约束 / 外键挂到已定义的表上），以及 COMMENT ON TABLE / COLUMN ... IS '...'。
 * 标识符支持 `$`（order$line）与 SQL Server 临时表名 `#temp` / `##global`。
 * 覆盖的边界 / 方言 / 报告问题场景见 src/test/parser-sql-*.test.ts。
 */

import type {
  ParseResult,
  ParsedColumn,
  ParsedForeignKey,
  ParsedRelationship,
  ParsedTable,
} from "../types";

// 标识符字符（含 `$`：PostgreSQL / Oracle 允许标识符里出现 `$`，如 order$line）。
const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$一-龥]/.test(c);

// ---------------------------------------------------------------------------
// 1. 注释消隐（保留偏移）：把注释替换成等长空白，字符串/引用标识符原样保留。
// ---------------------------------------------------------------------------
const blankComments = (src: string): string => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    // 单引号字符串：支持 '' 与 \' 转义
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "'" && src[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          out += "'";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 双引号（PG/标准 SQL 的引用标识符；MySQL 的字符串）：支持 "" 与 \" 转义
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '"' && src[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        if (src[i] === '"') {
          out += '"';
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 反引号（MySQL 引用标识符）：支持 `` 转义
    if (ch === "`") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "`" && src[i + 1] === "`") {
          out += "``";
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          out += "`";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // 方括号（SQLite / T-SQL 引用标识符；也可能是 PG 数组后缀 []）：支持 ]] 转义
    if (ch === "[") {
      out += ch;
      i++;
      while (i < n) {
        if (src[i] === "]" && src[i + 1] === "]") {
          out += "]]";
          i += 2;
          continue;
        }
        if (src[i] === "]") {
          out += "]";
          i++;
          break;
        }
        out += src[i++];
      }
      continue;
    }

    // dollar-quote（PostgreSQL）：$$...$$ / $tag$...$tag$ 原样保留。
    // 仅在词边界（前一字符不是标识符字符）才识别，避免把 order$line 这种
    // 标识符里的 `$` 误当成 dollar-quote 起始而吞掉后续内容。
    if (ch === "$" && !isWordChar(src[i - 1])) {
      const m = src.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        out += tag;
        i += tag.length;
        const end = src.indexOf(tag, i);
        if (end === -1) {
          out += src.slice(i);
          i = n;
        } else {
          out += src.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }

    // `--` 行注释 -> 等长空白（保留换行）
    if (ch === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // `#`：SQL Server 临时表名 #name / ##name（`#` 紧跟标识符字符或另一个 `#`）
    // 原样保留；否则按 MySQL `#` 行注释处理 -> 等长空白。
    if (ch === "#") {
      const next = src[i + 1];
      if (next && /[A-Za-z0-9_#一-龥]/.test(next)) {
        out += ch;
        i++;
        continue;
      }
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // `/* ... *\/` 块注释 -> 等长空白（保留换行，维持偏移）
    if (ch === "/" && src[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
};

// ---------------------------------------------------------------------------
// 2. 词法分析：字符串 / 引用标识符是原子 token，注释已被消隐。
// ---------------------------------------------------------------------------
type TokType = "str" | "ident" | "word" | "punct" | "arraysuffix" | "op";
interface Token {
  type: TokType;
  value: string;
  start: number;
  end: number;
  line: number;
  // 引用标识符的引号风格：`"` / `` ` `` / `[`。仅 ident 携带，用于在需要时把
  // 双引号 ident 还原为字符串（MySQL 默认模式下 COMMENT "..." 的 "..." 是字符串）。
  q?: string;
}

const WORD_RE = /[A-Za-z0-9_$一-龥]/;

const tokenize = (s: string): Token[] => {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = s.length;
  const push = (type: TokType, value: string, start: number, end: number, q?: string) =>
    toks.push({ type, value, start, end, line, ...(q ? { q } : {}) });

  while (i < n) {
    const ch = s[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }
    const start = i;

    // 单引号字符串
    if (ch === "'") {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "\\" && i + 1 < n) {
          val += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === "'" && s[i + 1] === "'") {
          val += "'";
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        val += s[i++];
      }
      push("str", val, start, i);
      continue;
    }

    // dollar-quote 字符串
    if (ch === "$") {
      const m = s.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        const contentEnd = close === -1 ? n : close;
        const val = s.slice(i + tag.length, contentEnd);
        i = close === -1 ? n : close + tag.length;
        push("str", val, start, i);
        continue;
      }
    }

    // 双引号引用标识符
    if (ch === '"') {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "\\" && i + 1 < n) {
          val += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === '"' && s[i + 1] === '"') {
          val += '"';
          i += 2;
          continue;
        }
        if (s[i] === '"') {
          i++;
          break;
        }
        val += s[i++];
      }
      push("ident", val, start, i, '"');
      continue;
    }

    // 反引号引用标识符
    if (ch === "`") {
      i++;
      let val = "";
      while (i < n) {
        if (s[i] === "`" && s[i + 1] === "`") {
          val += "`";
          i += 2;
          continue;
        }
        if (s[i] === "`") {
          i++;
          break;
        }
        val += s[i++];
      }
      push("ident", val, start, i, "`");
      continue;
    }

    // 方括号：空 / 纯数字 -> 数组后缀；否则 -> 引用标识符
    if (ch === "[") {
      let j = i + 1;
      let val = "";
      while (j < n) {
        if (s[j] === "]" && s[j + 1] === "]") {
          val += "]";
          j += 2;
          continue;
        }
        if (s[j] === "]") {
          j++;
          break;
        }
        val += s[j++];
      }
      i = j;
      const trimmed = val.trim();
      if (trimmed === "" || /^\d+$/.test(trimmed)) {
        push("arraysuffix", val, start, i);
      } else {
        push("ident", trimmed, start, i, "[");
      }
      continue;
    }

    // 结构标点
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "." || ch === "=") {
      i++;
      push("punct", ch, start, i);
      continue;
    }

    // `#` 开头：SQL Server 临时表名 #name / ##name（注释 `#` 已在消隐阶段去掉，
    // 这里看到的 `#` 必是标识符前缀）。落单的 `#` 当普通符号忽略。
    if (ch === "#") {
      let j = i;
      while (j < n && s[j] === "#") j++;
      if (j < n && WORD_RE.test(s[j])) {
        while (j < n && WORD_RE.test(s[j])) j++;
        push("word", s.slice(i, j), start, j);
        i = j;
        continue;
      }
      i++;
      push("op", "#", start, i);
      continue;
    }

    // 裸词（关键字 / 标识符 / 数字）
    if (WORD_RE.test(ch)) {
      let j = i;
      while (j < n && WORD_RE.test(s[j])) j++;
      push("word", s.slice(i, j), start, j);
      i = j;
      continue;
    }

    // 其它符号（+ - * / < > 等表达式运算符）
    i++;
    push("op", ch, start, i);
  }

  return toks;
};

// ---------------------------------------------------------------------------
// 3. 工具函数
// ---------------------------------------------------------------------------
const isNameTok = (t: Token | undefined): t is Token =>
  !!t && (t.type === "word" || t.type === "ident");

const kw = (t: Token | undefined): string | null =>
  t && t.type === "word" ? t.value.toUpperCase() : null;

// 读取 COMMENT 的值：单引号 / dollar-quote 字符串自然命中；MySQL 默认模式下
// `COMMENT "..."` 的 "..." 被词法器当作双引号 ident，这里把它还原成字符串值。
const readCommentValue = (t: Token | undefined): string | null => {
  if (!t) return null;
  if (t.type === "str") return t.value;
  if (t.type === "ident" && t.q === '"') return t.value;
  return null;
};

// 列定义里，遇到这些裸词关键字就认为类型部分结束。
const TYPE_STOP = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "FOREIGN",
  "REFERENCES",
  "NOT",
  "NULL",
  "DEFAULT",
  "UNIQUE",
  "CHECK",
  "COLLATE",
  "GENERATED",
  "COMMENT",
  "AUTO_INCREMENT",
  "AUTOINCREMENT",
  "IDENTITY",
  "CHARSET",
  "ENCODING",
  "STORAGE",
  "COMPRESSION",
  "VISIBLE",
  "INVISIBLE",
]);

// 列 / 表名常见数据类型关键字。仅用于消歧 `KEY` / `INDEX` / `FULLTEXT` 等
// 既可作约束起始词、又可作（保留字）列名的情况：若其后紧跟一个已知类型词，
// 判定为列名而非索引子句。
const KNOWN_TYPES = new Set([
  "INT",
  "INTEGER",
  "INT2",
  "INT4",
  "INT8",
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "BIGINT",
  "DECIMAL",
  "DEC",
  "NUMERIC",
  "FIXED",
  "NUMBER",
  "FLOAT",
  "DOUBLE",
  "REAL",
  "BIT",
  "BOOL",
  "BOOLEAN",
  "SERIAL",
  "BIGSERIAL",
  "SMALLSERIAL",
  "MONEY",
  "SMALLMONEY",
  "CHAR",
  "VARCHAR",
  "VARCHAR2",
  "NVARCHAR",
  "NCHAR",
  "CHARACTER",
  "NATIONAL",
  "STRING",
  "BINARY",
  "VARBINARY",
  "RAW",
  "BLOB",
  "TINYBLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BYTEA",
  "TEXT",
  "TINYTEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "CLOB",
  "NTEXT",
  "NVARCHAR2",
  "ENUM",
  "SET",
  "JSON",
  "JSONB",
  "XML",
  "UUID",
  "UNIQUEIDENTIFIER",
  "HSTORE",
  "CITEXT",
  "DATE",
  "DATETIME",
  "DATETIME2",
  "SMALLDATETIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "TIME",
  "TIMETZ",
  "YEAR",
  "INTERVAL",
  "DATETIMEOFFSET",
  "INET",
  "CIDR",
  "MACADDR",
  "MACADDR8",
  "BOX",
  "CIRCLE",
  "LINE",
  "LSEG",
  "PATH",
  "POINT",
  "POLYGON",
  "GEOMETRY",
  "GEOGRAPHY",
  "CUBE",
  "LTREE",
  "TSVECTOR",
  "TSQUERY",
  "ROWVERSION",
  "IMAGE",
  "SQL_VARIANT",
  "ARRAY",
  "VARIANT",
  "OBJECT",
]);

// 把一段 token（限定标识符，如 a / a.b / a.b.c）解析成限定名字符串。
// 返回 { name, next }：next 是限定名之后的 token 下标。
const readQualifiedName = (toks: Token[], from: number): { name: string; next: number } | null => {
  if (!isNameTok(toks[from])) return null;
  const parts = [toks[from].value];
  let p = from + 1;
  while (toks[p] && toks[p].type === "punct" && toks[p].value === "." && isNameTok(toks[p + 1])) {
    parts.push(toks[p + 1].value);
    p += 2;
  }
  return { name: parts.join("."), next: p };
};

// 从 openIdx（指向 '('）读到配对的 ')'，返回 [start, end]（含两端下标）。
const matchParen = (toks: Token[], openIdx: number): number => {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "punct" && t.value === "(") depth++;
    else if (t.type === "punct" && t.value === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// 在 [from, end) 内找第一个顶层 '(' 的下标（end 默认到结尾）。
const findOpenParen = (toks: Token[], from: number, end?: number): number => {
  const limit = end ?? toks.length;
  for (let i = from; i < limit; i++) {
    if (toks[i].type === "punct" && toks[i].value === "(") return i;
  }
  return -1;
};

// 按顶层逗号把 token 序列切成多段。
const splitByComma = (toks: Token[]): Token[][] => {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.type === "punct" && t.value === "(") {
      depth++;
      cur.push(t);
    } else if (t.type === "punct" && t.value === ")") {
      depth--;
      cur.push(t);
    } else if (t.type === "punct" && t.value === "," && depth === 0) {
      if (cur.length) parts.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
};

// 解析括号里的列名清单：每段取第一个标识符（自动忽略 `name(10)` 的前缀长度）。
const parseColumnNameList = (toks: Token[], openIdx: number): string[] => {
  const close = matchParen(toks, openIdx);
  if (close === -1) return [];
  const inner = toks.slice(openIdx + 1, close);
  return splitByComma(inner)
    .map((seg) => seg.find(isNameTok)?.value)
    .filter((v): v is string => !!v);
};

// ---------------------------------------------------------------------------
// 4. 语句切分（顶层 `;`，以及单独成行的 T-SQL 批处理分隔符 GO）
// ---------------------------------------------------------------------------
const splitStatements = (toks: Token[]): Token[][] => {
  const stmts: Token[][] = [];
  let cur: Token[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === "punct" && t.value === ";") {
      if (cur.length) stmts.push(cur);
      cur = [];
      continue;
    }
    // GO 单独成行（前后都不在同一行）时作为批处理分隔符。
    if (t.type === "word" && t.value.toUpperCase() === "GO") {
      const prev = toks[k - 1];
      const next = toks[k + 1];
      const aloneBefore = !prev || prev.line !== t.line;
      const aloneAfter = !next || next.line !== t.line;
      if (aloneBefore && aloneAfter) {
        if (cur.length) stmts.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) stmts.push(cur);
  return stmts;
};

// ---------------------------------------------------------------------------
// 5. 列 / 约束解析
// ---------------------------------------------------------------------------
interface TableAccum {
  columns: ParsedColumn[];
  primaryKeys: string[];
  foreignKeys: ParsedForeignKey[];
  uniqueSingleCols: Set<string>;
  tableName: string;
  // 已消隐注释的源码，用于按偏移切出类型字符串（保留原始书写）。
  cleaned: string;
}

// 解析一条列定义。
const parseColumn = (el: Token[], acc: TableAccum): void => {
  const nameTok = el[0];
  const name = nameTok.value;

  // 类型：从第二个 token 起，切到第一个顶层停止关键字之前。用源码偏移切片，
  // 保留原始书写（含括号、数组后缀 []、多词类型）。
  let typeStr = "";
  if (el.length > 1) {
    let depth = 0;
    let stopStart = -1;
    for (let i = 1; i < el.length; i++) {
      const t = el[i];
      if (t.type === "punct" && t.value === "(") depth++;
      else if (t.type === "punct" && t.value === ")") depth--;
      else if (depth === 0 && t.type === "word") {
        const u = t.value.toUpperCase();
        // `CHARACTER SET` 是字符集子句而非类型；`CHARACTER VARYING` 才是类型。
        if (u === "CHARACTER" && kw(el[i + 1]) === "SET") {
          stopStart = t.start;
          break;
        }
        if (TYPE_STOP.has(u)) {
          stopStart = t.start;
          break;
        }
      }
    }
    const sliceEnd = stopStart === -1 ? el[el.length - 1].end : stopStart;
    typeStr = acc.cleaned.slice(el[1].start, sliceEnd).trim();
  }

  // 内联约束 / 注释 / 外键：仅扫描顶层 token。
  let isPrimaryKey = false;
  let isUnique = false;
  let comment = "";
  let depth = 0;
  for (let i = 1; i < el.length; i++) {
    const t = el[i];
    if (t.type === "punct" && t.value === "(") {
      depth++;
      continue;
    }
    if (t.type === "punct" && t.value === ")") {
      depth--;
      continue;
    }
    if (depth !== 0 || t.type !== "word") continue;
    const u = t.value.toUpperCase();
    if (u === "PRIMARY" && kw(el[i + 1]) === "KEY") {
      isPrimaryKey = true;
    } else if (u === "UNIQUE") {
      isUnique = true;
    } else if (u === "COMMENT") {
      // COMMENT 'xxx' / COMMENT = 'xxx' / COMMENT "xxx"（MySQL）
      let j = i + 1;
      if (el[j] && el[j].type === "punct" && el[j].value === "=") j++;
      const cv = readCommentValue(el[j]);
      if (cv !== null) comment = cv;
    } else if (u === "REFERENCES") {
      const q = readQualifiedName(el, i + 1);
      if (q) {
        let referencedColumn = "";
        const op = findOpenParen(el, q.next);
        // 只接受紧跟在被引用表名之后的括号（中间不能隔着别的标识符）。
        if (op === q.next) {
          referencedColumn = parseColumnNameList(el, op).join(", ");
        }
        acc.foreignKeys.push({
          column: name,
          referencedTable: q.name,
          referencedColumn,
        });
      }
    }
  }

  if (isPrimaryKey) acc.primaryKeys.push(name);
  const col: ParsedColumn = {
    name,
    type: typeStr,
    isPrimaryKey,
    comment,
  };
  if (isUnique && !isPrimaryKey) col.isUnique = true;
  acc.columns.push(col);
};

const parsePrimaryKeyConstraint = (el: Token[], acc: TableAccum): void => {
  // el 形如 [PRIMARY, KEY, ...(可有 CLUSTERED 等修饰), (cols)]
  const op = findOpenParen(el, 2);
  if (op === -1) return;
  acc.primaryKeys.push(...parseColumnNameList(el, op));
};

const parseForeignKeyConstraint = (el: Token[], acc: TableAccum): void => {
  // el 形如 [FOREIGN, KEY, (cols), REFERENCES, qualname, (cols)]
  const fkOpen = findOpenParen(el, 2);
  if (fkOpen === -1) return;
  const fkCols = parseColumnNameList(el, fkOpen);
  if (!fkCols.length) return;
  const fkClose = matchParen(el, fkOpen);

  let refIdx = -1;
  for (let i = fkClose + 1; i < el.length; i++) {
    if (kw(el[i]) === "REFERENCES") {
      refIdx = i;
      break;
    }
  }
  if (refIdx === -1) return;
  const q = readQualifiedName(el, refIdx + 1);
  if (!q) return;
  let refCols: string[] = [];
  const refOpen = findOpenParen(el, q.next);
  if (refOpen === q.next) refCols = parseColumnNameList(el, refOpen);

  acc.foreignKeys.push({
    column: fkCols.join(", "),
    referencedTable: q.name,
    referencedColumn: refCols.join(", "),
  });
};

const parseUniqueConstraint = (el: Token[], acc: TableAccum): void => {
  // 取第一个括号里的列；单列时记为 unique，参与 1:1 推断。
  const op = findOpenParen(el, 1);
  if (op === -1) return;
  const cols = parseColumnNameList(el, op);
  if (cols.length === 1) acc.uniqueSingleCols.add(cols[0]);
};

// 判定一条表体元素是“约束”还是“列”，并分派解析。
const parseElement = (el: Token[], acc: TableAccum): void => {
  if (!el.length) return;
  const first = el[0];
  const head = kw(first);

  // 引用标识符（`"key"` / `` `key` `` / `[key]`）永远是列名。
  if (first.type !== "word" || head === null) {
    if (isNameTok(first)) parseColumn(el, acc);
    return;
  }

  switch (head) {
    case "CONSTRAINT": {
      // CONSTRAINT <name> <PRIMARY|FOREIGN|UNIQUE|CHECK> ... 才是命名约束；
      // 否则把 CONSTRAINT 当作（保留字）列名。
      if (
        isNameTok(el[1]) &&
        ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY", "INDEX"].includes(kw(el[2]) ?? "")
      ) {
        parseElement(el.slice(2), acc);
      } else {
        parseColumn(el, acc);
      }
      return;
    }
    case "PRIMARY": {
      if (kw(el[1]) === "KEY") parsePrimaryKeyConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "FOREIGN": {
      if (kw(el[1]) === "KEY") parseForeignKeyConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "UNIQUE": {
      const second = el[1];
      const isConstraint =
        (second && second.type === "punct" && second.value === "(") ||
        kw(second) === "KEY" ||
        kw(second) === "INDEX";
      if (isConstraint) parseUniqueConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "CHECK": {
      // CHECK ( ... ) 是约束；`check INT` 是列名。
      if (el[1] && el[1].type === "punct" && el[1].value === "(") return;
      parseColumn(el, acc);
      return;
    }
    case "KEY":
    case "INDEX":
    case "FULLTEXT":
    case "SPATIAL": {
      // 这些是 MySQL 索引子句，但也可能是（保留字）列名。判定：
      //   - 索引子句必带括号列清单；整段没有顶层 '(' 一定是列名（如 `key account_id_domain`）。
      //   - 有括号时，若第二个 token 是已知类型词，仍按列名处理（如 `key varchar(20)`）。
      const hasParen = el.some((t) => t.type === "punct" && t.value === "(");
      if (!hasParen || KNOWN_TYPES.has(kw(el[1]) ?? "")) parseColumn(el, acc);
      // 否则：索引子句，忽略。
      return;
    }
    case "PERIOD": {
      // PERIOD FOR SYSTEM_TIME (...) 是时态约束；否则列名。
      if (kw(el[1]) === "FOR") return;
      parseColumn(el, acc);
      return;
    }
    case "EXCLUDE": {
      // PG 排他约束 EXCLUDE USING ... / EXCLUDE (...)；否则列名。
      if (kw(el[1]) === "USING" || (el[1] && el[1].type === "punct" && el[1].value === "(")) return;
      parseColumn(el, acc);
      return;
    }
    case "LIKE": {
      // CREATE TABLE t (LIKE other ...) —— 由上层统一处理，这里忽略。
      return;
    }
    default:
      parseColumn(el, acc);
  }
};

// ---------------------------------------------------------------------------
// 6. 单条 CREATE TABLE 语句解析
// ---------------------------------------------------------------------------
type StmtResult =
  | { kind: "table"; table: ParsedTable; uniqueSingleCols: Set<string> }
  | { kind: "like"; name: string; source: string }
  | {
      kind: "alter";
      table: string;
      columns: ParsedColumn[];
      foreignKeys: ParsedForeignKey[];
      primaryKeys: string[];
      uniqueSingleCols: Set<string>;
    }
  | {
      kind: "comment";
      target: "table" | "column";
      tableFull: string;
      tableShort: string;
      column?: string;
      value: string;
    }
  | null;

const CREATE_MODIFIERS = new Set(["TEMP", "TEMPORARY", "GLOBAL", "LOCAL", "UNLOGGED"]);

// ALTER TABLE [IF EXISTS] [ONLY] <name> <action>[, <action>]... —— 把每个 ADD 动作
// 当成一条表体元素复用 parseElement，因此 ADD COLUMN（含内联 REFERENCES）、
// ADD [CONSTRAINT ...] PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK 全部覆盖。
const parseAlter = (toks: Token[], cleaned: string): StmtResult => {
  let p = 1; // 跳过 ALTER
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "EXISTS") p += 2;
  if (kw(toks[p]) === "ONLY") p++; // PostgreSQL: ALTER TABLE ONLY t
  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;

  const acc: TableAccum = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueSingleCols: new Set(),
    tableName: nameRead.name,
    cleaned,
  };

  for (const action of splitByComma(toks.slice(nameRead.next))) {
    if (kw(action[0]) !== "ADD") continue;
    let el = action.slice(1);
    if (kw(el[0]) === "COLUMN") {
      el = el.slice(1);
      if (kw(el[0]) === "IF" && kw(el[1]) === "NOT" && kw(el[2]) === "EXISTS") el = el.slice(3);
    }
    if (el.length) parseElement(el, acc);
  }

  if (
    !acc.columns.length &&
    !acc.foreignKeys.length &&
    !acc.primaryKeys.length &&
    !acc.uniqueSingleCols.size
  ) {
    return null;
  }
  return {
    kind: "alter",
    table: nameRead.name,
    columns: acc.columns,
    foreignKeys: acc.foreignKeys,
    primaryKeys: acc.primaryKeys,
    uniqueSingleCols: acc.uniqueSingleCols,
  };
};

// COMMENT ON {TABLE|COLUMN} <qual> IS '...' —— PostgreSQL / Oracle 用单独语句设置注释。
// 表名按 SQL 解析器的限定名规则保留 schema；COLUMN 形式的最后一段是列名。
const parseCommentOn = (toks: Token[]): StmtResult => {
  const target = kw(toks[2]);
  if (target !== "TABLE" && target !== "COLUMN") return null;
  const nameRead = readQualifiedName(toks, 3);
  if (!nameRead) return null;
  if (kw(toks[nameRead.next]) !== "IS") return null;
  const value = readCommentValue(toks[nameRead.next + 1]); // 字符串值；IS NULL 时为 null
  if (value === null) return null;
  const segs = nameRead.name.split(".");
  if (target === "COLUMN") {
    if (segs.length < 2) return null;
    return {
      kind: "comment",
      target: "column",
      tableFull: segs.slice(0, -1).join("."),
      tableShort: segs[segs.length - 2],
      column: segs[segs.length - 1],
      value,
    };
  }
  return {
    kind: "comment",
    target: "table",
    tableFull: nameRead.name,
    tableShort: segs[segs.length - 1],
    value,
  };
};

const extractTableComment = (suffix: Token[]): string | undefined => {
  for (let i = 0; i < suffix.length; i++) {
    if (kw(suffix[i]) === "COMMENT") {
      let j = i + 1;
      if (suffix[j] && suffix[j].type === "punct" && suffix[j].value === "=") j++;
      const cv = readCommentValue(suffix[j]);
      if (cv !== null) return cv;
    }
  }
  return undefined;
};

const parseStatement = (toks: Token[], cleaned: string): StmtResult => {
  if (kw(toks[0]) === "ALTER") return parseAlter(toks, cleaned);
  if (kw(toks[0]) === "COMMENT" && kw(toks[1]) === "ON") return parseCommentOn(toks);

  let p = 0;
  if (kw(toks[p]) !== "CREATE") return null;
  p++;
  // CREATE OR REPLACE TABLE ...（MariaDB / 部分方言）
  if (kw(toks[p]) === "OR" && kw(toks[p + 1]) === "REPLACE") p += 2;
  while (CREATE_MODIFIERS.has(kw(toks[p]) ?? "")) p++;
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;

  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;
  const tableName = nameRead.name;
  p = nameRead.next;

  // 处理特殊形式：
  const headKw = kw(toks[p]);

  // CREATE TABLE child PARTITION OF parent ... —— 分区子表，无独立列定义，跳过。
  if (headKw === "PARTITION" && kw(toks[p + 1]) === "OF") return null;

  // CREATE TABLE t AS SELECT ... —— 无法从 SELECT 推导列结构，跳过。
  if (headKw === "AS" || headKw === "SELECT") return null;

  // CREATE TABLE copy LIKE original —— 复制源表结构。
  if (headKw === "LIKE") {
    const src = readQualifiedName(toks, p + 1);
    return src ? { kind: "like", name: tableName, source: src.name } : null;
  }

  // 主体括号
  const open = findOpenParen(toks, p);
  if (open === -1) return null;
  const close = matchParen(toks, open);
  if (close === -1) return null;

  // 顶层若整体是 `( LIKE other )`，按结构复制处理。
  const bodyToks = toks.slice(open + 1, close);
  if (kw(bodyToks[0]) === "LIKE") {
    const src = readQualifiedName(bodyToks, 1);
    if (src && splitByComma(bodyToks).length === 1) {
      return { kind: "like", name: tableName, source: src.name };
    }
  }

  const suffix = toks.slice(close + 1);
  const tableComment = extractTableComment(suffix);

  const acc: TableAccum = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueSingleCols: new Set(),
    tableName,
    cleaned,
  };

  for (const el of splitByComma(bodyToks)) parseElement(el, acc);

  // 表级单列 UNIQUE 约束 -> 标记列 unique（用于 1:1 推断）。
  for (const col of acc.columns) {
    if (acc.uniqueSingleCols.has(col.name) && !col.isPrimaryKey) {
      col.isUnique = true;
    }
  }

  const table: ParsedTable = {
    name: tableName,
    columns: acc.columns,
    primaryKeys: acc.primaryKeys,
    foreignKeys: acc.foreignKeys,
    ...(tableComment ? { comment: tableComment } : {}),
  };
  return { kind: "table", table, uniqueSingleCols: acc.uniqueSingleCols };
};

// ---------------------------------------------------------------------------
// 7. 入口
// ---------------------------------------------------------------------------
export const parseSQLTables = (sql: string): ParseResult => {
  const cleaned = blankComments(sql);
  const allToks = tokenize(cleaned);

  const results: StmtResult[] = splitStatements(allToks).map((stmt) =>
    parseStatement(stmt, cleaned),
  );

  // 先收集真实表，供 LIKE 结构复制查找。
  const tableByName = new Map<string, ParsedTable>();
  for (const r of results) {
    if (r && r.kind === "table") tableByName.set(r.table.name, r.table);
  }

  const tables: ParsedTable[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.kind === "table") {
      tables.push(r.table);
    } else if (r.kind === "like") {
      // LIKE：复制源表的列与主键（不复制外键 / 关系，符合 LIKE 的默认语义）。
      const src = tableByName.get(r.source);
      tables.push({
        name: r.name,
        columns: src ? src.columns.map((c) => ({ ...c })) : [],
        primaryKeys: src ? [...src.primaryKeys] : [],
        foreignKeys: [],
      });
    }
    // alterfk：不产生新表，稍后挂接到已有表上。
  }

  const findTable = (full: string, short?: string): ParsedTable | undefined =>
    tables.find((tb) => tb.name === full) ??
    (short ? tables.find((tb) => tb.name === short) : undefined);

  // ALTER TABLE ... ADD ... —— 把新增的列 / 主键 / 唯一约束 / 外键挂到对应的（已定义）
  // 表上，再走后续统一的关系生成与基数推断。
  for (const r of results) {
    if (!r || r.kind !== "alter") continue;
    const t = findTable(r.table);
    if (!t) continue;
    for (const c of r.columns) {
      if (!t.columns.some((x) => x.name === c.name)) t.columns.push(c);
    }
    for (const pk of r.primaryKeys) {
      if (!t.primaryKeys.includes(pk)) t.primaryKeys.push(pk);
    }
    for (const uc of r.uniqueSingleCols) {
      const col = t.columns.find((x) => x.name === uc);
      if (col && !col.isPrimaryKey) col.isUnique = true;
    }
    t.foreignKeys.push(...r.foreignKeys);
  }

  // COMMENT ON TABLE / COLUMN —— 设置表 / 列注释（在关系生成之前，使 FK 列注释也能
  // 作为关系注释来源）。
  for (const r of results) {
    if (!r || r.kind !== "comment") continue;
    const t = findTable(r.tableFull, r.tableShort);
    if (!t) continue;
    if (r.target === "table") {
      t.comment = r.value;
    } else {
      const col = t.columns.find((c) => c.name === r.column);
      if (col) col.comment = r.value;
    }
  }

  // 由各表的外键推导关系，并做基数推断。
  const relationships: ParsedRelationship[] = [];
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const composite = fk.column.includes(",");
      const fkCol = t.columns.find((c) => c.name === fk.column);
      const isOnlySinglePk = t.primaryKeys.length === 1 && t.primaryKeys[0] === fk.column;
      const fromCardinality: "1" | "N" =
        !composite && (fkCol?.isUnique || isOnlySinglePk) ? "1" : "N";
      relationships.push({
        from: t.name,
        to: fk.referencedTable,
        label: fk.column,
        fromCardinality,
        toCardinality: "1",
        ...(fkCol?.comment ? { comment: fkCol.comment } : {}),
      });
    }
  }

  return { tables, relationships };
};
