// .claude/skills/sql2er/scripts/engine/shims.ts
var g = globalThis;
var clock = 1e9;
g.requestAnimationFrame = (cb) => {
  clock += 1e9;
  cb(clock);
  return 0;
};
g.cancelAnimationFrame = () => {
};

// .claude/skills/sql2er/scripts/engine/cli.ts
import { readFileSync, writeFileSync, existsSync, readFileSync as rf } from "node:fs";
import { resolve } from "node:path";

// src/parser/sql.ts
var isWordChar = (c) => !!c && /[A-Za-z0-9_$一-龥]/.test(c);
var blankComments = (src) => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
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
    if (ch === "-" && src[i + 1] === "-") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
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
var WORD_RE = /[A-Za-z0-9_$一-龥]/;
var tokenize = (s) => {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = s.length;
  const push = (type, value, start, end, q) => toks.push({ type, value, start, end, line, ...q ? { q } : {} });
  while (i < n) {
    const ch = s[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === " " || ch === "	" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }
    const start = i;
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
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === "." || ch === "=") {
      i++;
      push("punct", ch, start, i);
      continue;
    }
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
    if (WORD_RE.test(ch)) {
      let j = i;
      while (j < n && WORD_RE.test(s[j])) j++;
      push("word", s.slice(i, j), start, j);
      i = j;
      continue;
    }
    i++;
    push("op", ch, start, i);
  }
  return toks;
};
var isNameTok = (t) => !!t && (t.type === "word" || t.type === "ident");
var kw = (t) => t && t.type === "word" ? t.value.toUpperCase() : null;
var readCommentValue = (t) => {
  if (!t) return null;
  if (t.type === "str") return t.value;
  if (t.type === "ident" && t.q === '"') return t.value;
  return null;
};
var TYPE_STOP = /* @__PURE__ */ new Set([
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
  "INVISIBLE"
]);
var KNOWN_TYPES = /* @__PURE__ */ new Set([
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
  "OBJECT"
]);
var readQualifiedName = (toks, from) => {
  if (!isNameTok(toks[from])) return null;
  const parts = [toks[from].value];
  let p = from + 1;
  while (toks[p] && toks[p].type === "punct" && toks[p].value === "." && isNameTok(toks[p + 1])) {
    parts.push(toks[p + 1].value);
    p += 2;
  }
  return { name: parts.join("."), next: p };
};
var matchParen = (toks, openIdx) => {
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
var findOpenParen = (toks, from, end) => {
  const limit = end ?? toks.length;
  for (let i = from; i < limit; i++) {
    if (toks[i].type === "punct" && toks[i].value === "(") return i;
  }
  return -1;
};
var splitByComma = (toks) => {
  const parts = [];
  let cur = [];
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
var parseColumnNameList = (toks, openIdx) => {
  const close = matchParen(toks, openIdx);
  if (close === -1) return [];
  const inner = toks.slice(openIdx + 1, close);
  return splitByComma(inner).map((seg) => seg.find(isNameTok)?.value).filter((v) => !!v);
};
var splitStatements = (toks) => {
  const stmts = [];
  let cur = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === "punct" && t.value === ";") {
      if (cur.length) stmts.push(cur);
      cur = [];
      continue;
    }
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
var parseColumn = (el, acc) => {
  const nameTok = el[0];
  const name = nameTok.value;
  let typeStr = "";
  if (el.length > 1) {
    let depth2 = 0;
    let stopStart = -1;
    for (let i = 1; i < el.length; i++) {
      const t = el[i];
      if (t.type === "punct" && t.value === "(") depth2++;
      else if (t.type === "punct" && t.value === ")") depth2--;
      else if (depth2 === 0 && t.type === "word") {
        const u = t.value.toUpperCase();
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
      let j = i + 1;
      if (el[j] && el[j].type === "punct" && el[j].value === "=") j++;
      const cv = readCommentValue(el[j]);
      if (cv !== null) comment = cv;
    } else if (u === "REFERENCES") {
      const q = readQualifiedName(el, i + 1);
      if (q) {
        let referencedColumn = "";
        const op = findOpenParen(el, q.next);
        if (op === q.next) {
          referencedColumn = parseColumnNameList(el, op).join(", ");
        }
        acc.foreignKeys.push({
          column: name,
          referencedTable: q.name,
          referencedColumn
        });
      }
    }
  }
  if (isPrimaryKey) acc.primaryKeys.push(name);
  const col = {
    name,
    type: typeStr,
    isPrimaryKey,
    comment
  };
  if (isUnique && !isPrimaryKey) col.isUnique = true;
  acc.columns.push(col);
};
var parsePrimaryKeyConstraint = (el, acc) => {
  const op = findOpenParen(el, 2);
  if (op === -1) return;
  acc.primaryKeys.push(...parseColumnNameList(el, op));
};
var parseForeignKeyConstraint = (el, acc) => {
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
  let refCols = [];
  const refOpen = findOpenParen(el, q.next);
  if (refOpen === q.next) refCols = parseColumnNameList(el, refOpen);
  acc.foreignKeys.push({
    column: fkCols.join(", "),
    referencedTable: q.name,
    referencedColumn: refCols.join(", ")
  });
};
var parseUniqueConstraint = (el, acc) => {
  const op = findOpenParen(el, 1);
  if (op === -1) return;
  const cols = parseColumnNameList(el, op);
  if (cols.length === 1) acc.uniqueSingleCols.add(cols[0]);
};
var parseElement = (el, acc) => {
  if (!el.length) return;
  const first = el[0];
  const head = kw(first);
  if (first.type !== "word" || head === null) {
    if (isNameTok(first)) parseColumn(el, acc);
    return;
  }
  switch (head) {
    case "CONSTRAINT": {
      if (isNameTok(el[1]) && ["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY", "INDEX"].includes(kw(el[2]) ?? "")) {
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
      const isConstraint = second && second.type === "punct" && second.value === "(" || kw(second) === "KEY" || kw(second) === "INDEX";
      if (isConstraint) parseUniqueConstraint(el, acc);
      else parseColumn(el, acc);
      return;
    }
    case "CHECK": {
      if (el[1] && el[1].type === "punct" && el[1].value === "(") return;
      parseColumn(el, acc);
      return;
    }
    case "KEY":
    case "INDEX":
    case "FULLTEXT":
    case "SPATIAL": {
      const hasParen = el.some((t) => t.type === "punct" && t.value === "(");
      if (!hasParen || KNOWN_TYPES.has(kw(el[1]) ?? "")) parseColumn(el, acc);
      return;
    }
    case "PERIOD": {
      if (kw(el[1]) === "FOR") return;
      parseColumn(el, acc);
      return;
    }
    case "EXCLUDE": {
      if (kw(el[1]) === "USING" || el[1] && el[1].type === "punct" && el[1].value === "(") return;
      parseColumn(el, acc);
      return;
    }
    case "LIKE": {
      return;
    }
    default:
      parseColumn(el, acc);
  }
};
var CREATE_MODIFIERS = /* @__PURE__ */ new Set(["TEMP", "TEMPORARY", "GLOBAL", "LOCAL", "UNLOGGED"]);
var parseAlter = (toks, cleaned) => {
  let p = 1;
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "EXISTS") p += 2;
  if (kw(toks[p]) === "ONLY") p++;
  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;
  const acc = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueSingleCols: /* @__PURE__ */ new Set(),
    tableName: nameRead.name,
    cleaned
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
  if (!acc.columns.length && !acc.foreignKeys.length && !acc.primaryKeys.length && !acc.uniqueSingleCols.size) {
    return null;
  }
  return {
    kind: "alter",
    table: nameRead.name,
    columns: acc.columns,
    foreignKeys: acc.foreignKeys,
    primaryKeys: acc.primaryKeys,
    uniqueSingleCols: acc.uniqueSingleCols
  };
};
var parseCommentOn = (toks) => {
  const target = kw(toks[2]);
  if (target !== "TABLE" && target !== "COLUMN") return null;
  const nameRead = readQualifiedName(toks, 3);
  if (!nameRead) return null;
  if (kw(toks[nameRead.next]) !== "IS") return null;
  const value = readCommentValue(toks[nameRead.next + 1]);
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
      value
    };
  }
  return {
    kind: "comment",
    target: "table",
    tableFull: nameRead.name,
    tableShort: segs[segs.length - 1],
    value
  };
};
var extractTableComment = (suffix) => {
  for (let i = 0; i < suffix.length; i++) {
    if (kw(suffix[i]) === "COMMENT") {
      let j = i + 1;
      if (suffix[j] && suffix[j].type === "punct" && suffix[j].value === "=") j++;
      const cv = readCommentValue(suffix[j]);
      if (cv !== null) return cv;
    }
  }
  return void 0;
};
var parseStatement = (toks, cleaned) => {
  if (kw(toks[0]) === "ALTER") return parseAlter(toks, cleaned);
  if (kw(toks[0]) === "COMMENT" && kw(toks[1]) === "ON") return parseCommentOn(toks);
  let p = 0;
  if (kw(toks[p]) !== "CREATE") return null;
  p++;
  if (kw(toks[p]) === "OR" && kw(toks[p + 1]) === "REPLACE") p += 2;
  while (CREATE_MODIFIERS.has(kw(toks[p]) ?? "")) p++;
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;
  const nameRead = readQualifiedName(toks, p);
  if (!nameRead) return null;
  const tableName = nameRead.name;
  p = nameRead.next;
  const headKw = kw(toks[p]);
  if (headKw === "PARTITION" && kw(toks[p + 1]) === "OF") return null;
  if (headKw === "AS" || headKw === "SELECT") return null;
  if (headKw === "LIKE") {
    const src = readQualifiedName(toks, p + 1);
    return src ? { kind: "like", name: tableName, source: src.name } : null;
  }
  const open = findOpenParen(toks, p);
  if (open === -1) return null;
  const close = matchParen(toks, open);
  if (close === -1) return null;
  const bodyToks = toks.slice(open + 1, close);
  if (kw(bodyToks[0]) === "LIKE") {
    const src = readQualifiedName(bodyToks, 1);
    if (src && splitByComma(bodyToks).length === 1) {
      return { kind: "like", name: tableName, source: src.name };
    }
  }
  const suffix = toks.slice(close + 1);
  const tableComment = extractTableComment(suffix);
  const acc = {
    columns: [],
    primaryKeys: [],
    foreignKeys: [],
    uniqueSingleCols: /* @__PURE__ */ new Set(),
    tableName,
    cleaned
  };
  for (const el of splitByComma(bodyToks)) parseElement(el, acc);
  for (const col of acc.columns) {
    if (acc.uniqueSingleCols.has(col.name) && !col.isPrimaryKey) {
      col.isUnique = true;
    }
  }
  const table = {
    name: tableName,
    columns: acc.columns,
    primaryKeys: acc.primaryKeys,
    foreignKeys: acc.foreignKeys,
    ...tableComment ? { comment: tableComment } : {}
  };
  return { kind: "table", table, uniqueSingleCols: acc.uniqueSingleCols };
};
var parseSQLTables = (sql) => {
  const cleaned = blankComments(sql);
  const allToks = tokenize(cleaned);
  const results = splitStatements(allToks).map(
    (stmt) => parseStatement(stmt, cleaned)
  );
  const tableByName = /* @__PURE__ */ new Map();
  for (const r of results) {
    if (r && r.kind === "table") tableByName.set(r.table.name, r.table);
  }
  const tables = [];
  for (const r of results) {
    if (!r) continue;
    if (r.kind === "table") {
      tables.push(r.table);
    } else if (r.kind === "like") {
      const src = tableByName.get(r.source);
      tables.push({
        name: r.name,
        columns: src ? src.columns.map((c) => ({ ...c })) : [],
        primaryKeys: src ? [...src.primaryKeys] : [],
        foreignKeys: []
      });
    }
  }
  const findTable = (full, short2) => tables.find((tb) => tb.name === full) ?? (short2 ? tables.find((tb) => tb.name === short2) : void 0);
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
  const relationships = [];
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const composite = fk.column.includes(",");
      const fkCol = t.columns.find((c) => c.name === fk.column);
      const isOnlySinglePk = t.primaryKeys.length === 1 && t.primaryKeys[0] === fk.column;
      const fromCardinality = !composite && (fkCol?.isUnique || isOnlySinglePk) ? "1" : "N";
      relationships.push({
        from: t.name,
        to: fk.referencedTable,
        label: fk.column,
        fromCardinality,
        toCardinality: "1",
        ...fkCol?.comment ? { comment: fkCol.comment } : {}
      });
    }
  }
  return { tables, relationships };
};

// src/parser/dbml.ts
var IDENT = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w一-龥]+)`;
var QUALIFIED_IDENT = String.raw`${IDENT}(?:\.${IDENT})*`;
var stripOuterQuotes = (seg) => seg.trim().replace(/^[`"\[]|[`"\]]$/g, "");
var splitQualified = (raw) => {
  const parts = [];
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
var cleanIdentifier = (raw) => {
  const parts = splitQualified(raw);
  const last = parts.length ? parts[parts.length - 1] : raw.trim();
  return stripOuterQuotes(last) || raw.trim();
};
var stripQuotes = (s) => {
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
var skipString = (src, i) => {
  if (src[i] === "'" && src[i + 1] === "'" && src[i + 2] === "'") {
    let j2 = i + 3;
    while (j2 < src.length && !(src[j2] === "'" && src[j2 + 1] === "'" && src[j2 + 2] === "'")) {
      j2++;
    }
    return Math.min(src.length, j2 + 3);
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
var stripDbmlComments = (src) => {
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
var findMatchingBrace = (src, openIdx) => {
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
var findMatchingBracket = (src, openIdx) => {
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
var indexOfUnquoted = (s, needle, from = 0) => {
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
var splitTopLevelCommas = (s) => {
  const out = [];
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
var splitLogicalLines = (body) => {
  const lines = [];
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
var parseRefTarget = (raw) => {
  let cleaned = raw.trim().replace(/^,+|,+$/g, "").trim();
  const lb = indexOfUnquoted(cleaned, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(cleaned, lb);
    if (rb !== -1) {
      cleaned = (cleaned.slice(0, lb) + " " + cleaned.slice(rb + 1)).trim();
    }
  }
  if (!cleaned) return null;
  const segs = splitQualified(cleaned).map(stripOuterQuotes).filter(Boolean);
  if (segs.length < 2) return null;
  let column = segs[segs.length - 1];
  const composite = column.match(/^\(\s*([\s\S]+?)\s*\)$/);
  if (composite) {
    column = composite[1].split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  }
  return { table: segs[segs.length - 2], column };
};
var parseInlineRef = (refValue) => {
  const m = refValue.match(/^\s*(<>|[<>\-])\s*(.+)$/);
  if (!m) return null;
  const target = parseRefTarget(m[2]);
  return target ? { op: m[1], target } : null;
};
var parseColumnAttrs = (attrsRaw) => splitTopLevelCommas(attrsRaw).map((part) => {
  const colon = indexOfUnquoted(part, ":");
  if (colon === -1) {
    return {
      key: part.trim().toLowerCase().replace(/\s+/g, " "),
      value: null
    };
  }
  return {
    key: part.slice(0, colon).trim().toLowerCase().replace(/\s+/g, " "),
    value: part.slice(colon + 1).trim()
  };
});
var findSettingsBracket = (s) => {
  let i = 0;
  let last = null;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "[") {
      const rb = findMatchingBracket(s, i);
      if (rb === -1) break;
      if (s.slice(0, i).trim() !== "") last = { lb: i, rb };
      i = rb + 1;
      continue;
    }
    i++;
  }
  if (!last) return null;
  const content = s.slice(last.lb + 1, last.rb).trim();
  if (content === "" || /^\d+$/.test(content)) return null;
  return last;
};
var parseColumnLine = (line) => {
  const trimmed = line.trim();
  const sb = findSettingsBracket(trimmed);
  let head;
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
  let inlineRef = null;
  let comment;
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
  const column = { name, type, isPrimaryKey };
  if (isUnique) column.isUnique = true;
  if (comment !== void 0) column.comment = comment;
  return { column, inlineRef };
};
var stripRefSettings = (body) => {
  let cleaned = body;
  let comment;
  const lb = indexOfUnquoted(cleaned, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(cleaned, lb);
    if (rb !== -1) {
      const inner = cleaned.slice(lb + 1, rb);
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
var parseRefBody = (rawBody) => {
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
      return from && to ? { from, to, op: "<>", ...comment ? { comment } : {} } : null;
    }
    if (ch === "<" || ch === ">" || ch === "-") {
      const left = body.slice(0, i).trim();
      const right = body.slice(i + 1).trim();
      const from = parseRefTarget(left);
      const to = parseRefTarget(right);
      if (from && to) return { from, to, op: ch, ...comment ? { comment } : {} };
    }
    i++;
  }
  return null;
};
var classifyHeader = (header) => {
  if (/^TablePartial\b/i.test(header)) return "unknown";
  if (/^TableGroup\b/i.test(header)) return "tablegroup";
  if (/^Table\b/i.test(header)) return "table";
  if (/^Ref\b[^{]*:/i.test(header)) return "ref";
  if (/^Ref\b/i.test(header)) return "refblock";
  if (/^Enum\b/i.test(header)) return "enum";
  if (/^Project\b/i.test(header)) return "project";
  if (/^DiagramView\b/i.test(header)) return "unknown";
  if (/^records\b/i.test(header)) return "unknown";
  if (/^Note\b/i.test(header)) return "unknown";
  return "unknown";
};
var TOP_KEYWORD_RE = /^(TablePartial|TableGroup|Table|Ref|Project|Enum|DiagramView|records|Note)\b/i;
var findNextKeyword = (src, from) => {
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
var tokenizeTopLevel = (src) => {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
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
      const header2 = src.slice(startIdx, braceIdx).trim();
      const closeIdx = findMatchingBrace(src, braceIdx);
      if (closeIdx === -1) break;
      const body = src.slice(braceIdx + 1, closeIdx);
      out.push({ kind: classifyHeader(header2), header: header2, body });
      i = closeIdx + 1;
      continue;
    }
    if (lineEndIdx !== -1) {
      const header2 = src.slice(startIdx, lineEndIdx).trim();
      if (header2) out.push({ kind: classifyHeader(header2), header: header2, body: null });
      i = lineEndIdx + 1;
      continue;
    }
    const header = src.slice(startIdx).trim();
    if (header) out.push({ kind: classifyHeader(header), header, body: null });
    break;
  }
  return out;
};
var parseTableHeader = (header) => {
  let h = header;
  const lb = indexOfUnquoted(h, "[");
  if (lb !== -1) {
    const rb = findMatchingBracket(h, lb);
    if (rb !== -1) h = (h.slice(0, lb) + " " + h.slice(rb + 1)).trim();
  }
  const m = h.match(
    new RegExp(String.raw`^Table\s+(${QUALIFIED_IDENT})(?:\s+as\s+(${IDENT}))?\s*$`, "i")
  );
  if (!m) return null;
  return {
    name: cleanIdentifier(m[1]),
    alias: m[2] ? cleanIdentifier(m[2]) : void 0
  };
};
var opToCardinality = (op) => {
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
var addRelationship = (ref, relationships, tableByName) => {
  const card = opToCardinality(ref.op);
  relationships.push({
    from: ref.from.table,
    to: ref.to.table,
    label: ref.from.column,
    fromCardinality: card.from,
    toCardinality: card.to,
    ...ref.comment ? { comment: ref.comment } : {}
  });
  const t = tableByName.get(ref.from.table);
  if (t) {
    t.foreignKeys = t.foreignKeys || [];
    t.foreignKeys.push({
      column: ref.from.column,
      referencedTable: ref.to.table,
      referencedColumn: ref.to.column
    });
  }
};
var extractTableNote = (body) => {
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
  return void 0;
};
var parseIndexColumns = (head) => {
  const h = head.trim();
  if (h.startsWith("`")) return null;
  if (h.startsWith("(")) {
    const inner = h.replace(/^\(|\)$/g, "");
    return splitTopLevelCommas(inner).map(cleanIdentifier).filter(Boolean);
  }
  const c = cleanIdentifier(h);
  return c ? [c] : null;
};
var extractIndexesConstraints = (blockBody) => {
  const pkCols = [];
  const uniqueCols = [];
  for (const raw of splitLogicalLines(blockBody)) {
    const line = raw.trim();
    if (!line) continue;
    const sb = findSettingsBracket(line);
    if (!sb) continue;
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
    if (isUnique && cols.length === 1) uniqueCols.push(cols[0]);
  }
  return { pkCols, uniqueCols };
};
var parseDBML = (dbml) => {
  const tables = [];
  const relationships = [];
  const tableByName = /* @__PURE__ */ new Map();
  const cleanSrc = stripDbmlComments(dbml);
  for (const stmt of tokenizeTopLevel(cleanSrc)) {
    if (stmt.kind === "table" && stmt.body !== null) {
      const head = parseTableHeader(stmt.header);
      if (!head) continue;
      const columns = [];
      const primaryKeys = [];
      const foreignKeys = [];
      const indexPkCols = [];
      const indexUniqueCols = [];
      for (const line of splitLogicalLines(stmt.body)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
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
            referencedColumn: inlineRef.target.column
          });
          const card = opToCardinality(inlineRef.op);
          relationships.push({
            from: head.name,
            to: inlineRef.target.table,
            label: column.name,
            fromCardinality: card.from,
            toCardinality: card.to
          });
        }
        columns.push(column);
      }
      for (const c of indexPkCols) {
        if (!primaryKeys.includes(c)) primaryKeys.push(c);
      }
      for (const c of indexUniqueCols) {
        const col = columns.find((x) => x.name === c);
        if (col && !col.isPrimaryKey) col.isUnique = true;
      }
      const tableNote = extractTableNote(stmt.body);
      const table = {
        name: head.name,
        alias: head.alias,
        columns,
        primaryKeys,
        foreignKeys,
        ...tableNote ? { comment: tableNote } : {}
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
  }
  for (const rel of relationships) {
    if (rel.fromCardinality !== "N" || rel.toCardinality !== "1") continue;
    if (rel.label.includes(",")) continue;
    const fromTable = tableByName.get(rel.from);
    if (!fromTable) continue;
    const col = fromTable.columns.find((c) => c.name === rel.label);
    if (!col) continue;
    const isOnlySinglePk = fromTable.primaryKeys.length === 1 && fromTable.primaryKeys[0] === col.name;
    if (col.isUnique || isOnlySinglePk) {
      rel.fromCardinality = "1";
    }
  }
  return { tables, relationships };
};

// src/builder.ts
var pickLabel = (name, comment, labelMode) => {
  const n = name || "";
  const c = comment || "";
  if (labelMode === "name") return n;
  if (labelMode === "comment") return c || n;
  return c || n;
};
var resolveAttrLabel = (column, labelMode) => pickLabel(column.name || "", column.comment, labelMode);
var generateChenModelData = (tables, relationships, isColored = true, labelMode = "name", hideFields = false) => {
  const nodes = [];
  const edges = [];
  const entityMap = /* @__PURE__ */ new Map();
  tables.forEach((table, tableIndex) => {
    const entityId = `entity-${table.name}-${tableIndex}`;
    entityMap.set(table.name, entityId);
    if (table.alias) {
      entityMap.set(table.alias, entityId);
    }
    const entityLabel = pickLabel(table.name, table.comment, labelMode);
    nodes.push({
      id: entityId,
      type: "entity",
      label: entityLabel,
      // 在节点上保留两份候选标签，方便"显示注释"开关原地切换。
      nameLabel: table.name,
      commentLabel: table.comment || table.name,
      // 移除固定的x,y坐标，让布局算法自动处理
      style: {
        fill: "#ffffff",
        stroke: isColored ? "#595959" : "#000000",
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: "#000000",
          fontWeight: "bold"
        }
      },
      // 添加节点分类信息，用于布局算法
      nodeType: "entity"
    });
    if (!hideFields) {
      const fkOnlyColumns = new Set(
        table.foreignKeys.map((fk) => fk.column).filter((col) => !table.primaryKeys.includes(col))
      );
      table.columns.forEach((column, colIndex) => {
        if (fkOnlyColumns.has(column.name)) return;
        const attributeId = `attr-${table.name}-${column.name}-${tableIndex}-${colIndex}`;
        const isPrimaryKey = table.primaryKeys.includes(column.name) || column.isPrimaryKey;
        const attrLabel = resolveAttrLabel(column, labelMode);
        nodes.push({
          id: attributeId,
          type: "attribute",
          label: attrLabel,
          nameLabel: column.name,
          commentLabel: column.comment || column.name,
          // 移除固定位置
          keyType: isPrimaryKey ? "pk" : "normal",
          style: {
            fill: isColored ? isPrimaryKey ? "#f6ffed" : "#fffbe6" : "#ffffff",
            stroke: isColored ? isPrimaryKey ? "#52c41a" : "#faad14" : "#000000",
            lineWidth: isPrimaryKey ? 2 : 1
          },
          labelCfg: {
            style: {
              fill: "#000000",
              fontWeight: isPrimaryKey ? "bold" : "normal"
            }
          },
          nodeType: "attribute",
          parentEntity: entityId
          // 标记父实体
        });
        edges.push({
          id: `edge-${entityId}-${attributeId}-${tableIndex}-${colIndex}`,
          source: entityId,
          target: attributeId,
          style: {
            stroke: "#000000"
          },
          edgeType: "entity-attribute"
        });
      });
    }
  });
  relationships.forEach((rel) => {
    if (!entityMap.has(rel.to)) {
      const placeholderIndex = nodes.filter((n) => n.nodeType === "entity").length;
      const entityId = `entity-${rel.to}-${placeholderIndex}`;
      entityMap.set(rel.to, entityId);
      nodes.push({
        id: entityId,
        type: "entity",
        label: rel.to,
        nameLabel: rel.to,
        // 占位实体没有解析到的表注释，commentLabel 兜底回原名
        commentLabel: rel.to,
        style: {
          fill: "#ffffff",
          stroke: isColored ? "#595959" : "#000000",
          lineWidth: 2,
          lineDash: [4, 4]
        },
        labelCfg: {
          style: {
            fill: isColored ? "#999999" : "#666666",
            fontWeight: "bold"
          }
        },
        nodeType: "entity",
        isPlaceholder: true
      });
    }
  });
  const tableByName = /* @__PURE__ */ new Map();
  tables.forEach((t) => {
    tableByName.set(t.name, t);
    if (t.alias) tableByName.set(t.alias, t);
  });
  const lookupRelComment = (rel) => {
    if (rel.comment) return rel.comment;
    const fromTable = tableByName.get(rel.from);
    if (!fromTable) return void 0;
    const cols = rel.label.split(",").map((s) => s.trim()).filter(Boolean);
    for (const c of cols) {
      const found = fromTable.columns.find((col) => col.name === c);
      if (found?.comment) return found.comment;
    }
    return void 0;
  };
  relationships.forEach((rel, relIndex) => {
    const relationshipId = `rel-${rel.from}-${rel.to}-${rel.label}-${relIndex}`;
    const isSelfLoop = rel.from === rel.to;
    const relComment = lookupRelComment(rel);
    const relLabel = pickLabel(rel.label, relComment, labelMode);
    nodes.push({
      id: relationshipId,
      type: "relationship",
      label: relLabel,
      nameLabel: rel.label,
      commentLabel: relComment || rel.label,
      style: {
        fill: isColored ? "#f9f0ff" : "#ffffff",
        stroke: isColored ? "#722ed1" : "#000000",
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: "#000000"
        }
      },
      nodeType: "relationship",
      isSelfLoop
    });
    const fromLabel = rel.fromCardinality ?? "N";
    const toLabel = rel.toCardinality ?? "1";
    edges.push({
      id: `edge-entity-${rel.from}-${relationshipId}-${relIndex}-1`,
      source: entityMap.get(rel.from),
      target: relationshipId,
      label: fromLabel,
      type: isSelfLoop ? "self-loop-arc" : void 0,
      curveOffset: isSelfLoop ? 22 : void 0,
      style: {
        stroke: "#000000",
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: "#000000",
          background: {
            fill: "#ffffff",
            padding: [2, 4, 2, 4]
          }
        }
      },
      edgeType: "entity-relationship"
    });
    edges.push({
      id: `edge-${relationshipId}-entity-${rel.to}-${relIndex}-2`,
      source: relationshipId,
      target: entityMap.get(rel.to),
      label: toLabel,
      type: isSelfLoop ? "self-loop-arc" : void 0,
      curveOffset: isSelfLoop ? 22 : void 0,
      style: {
        stroke: "#000000",
        lineWidth: 2
      },
      labelCfg: {
        style: {
          fill: "#000000",
          background: {
            fill: "#ffffff",
            padding: [2, 4, 2, 4]
          }
        }
      },
      edgeType: "relationship-entity"
    });
  });
  return { nodes, edges };
};
var getTextWidth = (text, fontSize) => {
  let width = 0;
  for (let char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      width += fontSize;
    } else {
      width += fontSize * 0.6;
    }
  }
  return width;
};
var getFontScale = (fontSize, baseFontSize) => fontSize / baseFontSize;
var getShrinkOnlyScale = (fontSize, baseFontSize) => Math.min(1, getFontScale(fontSize, baseFontSize));
var getAttributeHeight = (fontSize, hasUnderline) => {
  const scale = getShrinkOnlyScale(fontSize, 15);
  const minHeight = 40 * scale;
  const verticalRoom = (hasUnderline ? 24 : 16) * scale;
  return Math.max(minHeight, fontSize + verticalRoom);
};
var estimateAttributeHalfSize = (label, fontSize = 15, hasUnderline = false) => {
  const scale = getShrinkOnlyScale(fontSize, 15);
  const padding = 16 * scale;
  const minWidth = 60 * scale;
  const textWidth = getTextWidth(label || "", fontSize);
  const width = Math.max(minWidth, textWidth + padding * 2);
  const height = getAttributeHeight(fontSize, hasUnderline);
  return { halfW: width / 2, halfH: height / 2 };
};
var measureEntitySize = (label, fontSize = 18) => {
  const scale = getShrinkOnlyScale(fontSize, 18);
  const textWidth = getTextWidth(label || "", fontSize);
  const padding = 10 * scale;
  const width = Math.max(80 * scale, textWidth + padding * 2);
  const height = Math.max(50 * scale, fontSize + 20 * scale);
  return { width, height };
};
var measureAttributeSize = (label, fontSize = 15, isPrimaryKey = false) => {
  const { halfW, halfH } = estimateAttributeHalfSize(label, fontSize, isPrimaryKey);
  return { width: halfW * 2, height: halfH * 2 };
};
var measureRelationshipSize = (label, fontSize = 16) => {
  const scale = getShrinkOnlyScale(fontSize, 16);
  const textWidth = getTextWidth(label || "", fontSize);
  const horizontalPadding = 24 * scale;
  const verticalPadding = 16 * scale;
  const minWidth = 80 * scale;
  const minHeight = 40 * scale;
  const requiredWidth = textWidth + horizontalPadding * 2;
  const requiredHeight = fontSize + verticalPadding * 2;
  const halfWidth = Math.max(minWidth / 2, requiredWidth / 2);
  const halfHeight = Math.max(minHeight / 2, Math.min(halfWidth * 0.6, requiredHeight / 2));
  return { width: halfWidth * 2, height: halfHeight * 2 };
};
var NODE_FONT_BASE = { entity: 18, relationship: 16, attribute: 15 };
var measureNodeSize = (model) => {
  const type = model.nodeType || "entity";
  const base = NODE_FONT_BASE[type] ?? 15;
  const raw = model.labelCfg?.style?.fontSize;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  const fontSize = Number.isFinite(parsed) && parsed > 0 ? parsed : base;
  const label = model.label == null ? "" : String(model.label);
  if (type === "entity") return measureEntitySize(label, fontSize);
  if (type === "relationship") return measureRelationshipSize(label, fontSize);
  return measureAttributeSize(label, fontSize, model.keyType === "pk");
};

// src/layout/utils.ts
var deterministicHash = (str, extraSeed = 0) => {
  let hash = extraSeed;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
};
var normalizeAngle = (a) => {
  let ang = a % (Math.PI * 2);
  if (ang < 0) ang += Math.PI * 2;
  return ang;
};

// src/layout/animation.ts
var nodeAnimationTokens = /* @__PURE__ */ new WeakMap();
var fitViewTokens = /* @__PURE__ */ new WeakMap();
var nextToken = (tokens, graph) => {
  const token = (tokens.get(graph) ?? 0) + 1;
  tokens.set(graph, token);
  return token;
};
var isCurrentToken = (tokens, graph, token) => tokens.get(graph) === token;
var smoothFitView = (graph, duration = 800, easing = "easeOutCubic") => {
  if (!graph || graph.destroyed) return;
  const token = nextToken(fitViewTokens, graph);
  try {
    const nodes = graph.getNodes();
    if (!nodes || nodes.length === 0) {
      graph.fitView(20);
      return;
    }
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    nodes.forEach((node) => {
      const bbox = node.getBBox();
      minX = Math.min(minX, bbox.minX);
      maxX = Math.max(maxX, bbox.maxX);
      minY = Math.min(minY, bbox.minY);
      maxY = Math.max(maxY, bbox.maxY);
    });
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;
    if (contentWidth === 0 || contentHeight === 0) {
      graph.fitView(20);
      return;
    }
    const graphWidth = graph.get("width");
    const graphHeight = graph.get("height");
    const padding = 40;
    const scaleX = (graphWidth - padding * 2) / contentWidth;
    const scaleY = (graphHeight - padding * 2) / contentHeight;
    const targetZoom = Math.min(scaleX, scaleY);
    const targetCenterX = graphWidth / 2 - contentCenterX * targetZoom;
    const targetCenterY = graphHeight / 2 - contentCenterY * targetZoom;
    const currentZoom = graph.getZoom();
    const currentMatrix = graph.get("group").getMatrix();
    const currentCenterX = currentMatrix ? currentMatrix[6] : 0;
    const currentCenterY = currentMatrix ? currentMatrix[7] : 0;
    const startTime = performance.now();
    const animate = (currentTime) => {
      if (!graph || graph.destroyed || !isCurrentToken(fitViewTokens, graph, token)) return;
      const elapsed = currentTime - startTime;
      let progress = Math.min(elapsed / duration, 1);
      if (easing === "easeOutQuart") {
        progress = 1 - Math.pow(1 - progress, 4);
      } else {
        progress = 1 - Math.pow(1 - progress, 3);
      }
      const frameZoom = currentZoom + (targetZoom - currentZoom) * progress;
      const frameCenterX = currentCenterX + (targetCenterX - currentCenterX) * progress;
      const frameCenterY = currentCenterY + (targetCenterY - currentCenterY) * progress;
      const groupMatrix = [frameZoom, 0, 0, 0, frameZoom, 0, frameCenterX, frameCenterY, 1];
      graph.get("group").setMatrix(groupMatrix);
      graph.paint();
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  } catch (error) {
    console.warn("Smooth fit view failed, falling back to instant fit:", error);
    graph.fitView(20);
  }
};
var animateNodesToTargets = (graph, targets, duration = 800, onFinish) => {
  if (!graph || graph.destroyed || !targets?.size) {
    if (onFinish) onFinish();
    return;
  }
  const token = nextToken(nodeAnimationTokens, graph);
  nextToken(fitViewTokens, graph);
  const startPositions = /* @__PURE__ */ new Map();
  graph.getNodes().forEach((node) => {
    const model = node.getModel();
    startPositions.set(model.id, { x: model.x, y: model.y });
  });
  const startTime = performance.now();
  graph.setAutoPaint(false);
  const step = (currentTime) => {
    if (!graph || graph.destroyed || !isCurrentToken(nodeAnimationTokens, graph, token)) return;
    const elapsed = currentTime - startTime;
    const rawProgress = Math.min(elapsed / duration, 1);
    const progress = 1 - Math.pow(1 - rawProgress, 3);
    targets.forEach((target, id) => {
      const node = graph.findById(id);
      if (!node) return;
      const start = startPositions.get(id) || target;
      const startX = typeof start.x === "number" ? start.x : 0;
      const startY = typeof start.y === "number" ? start.y : 0;
      const targetX = typeof target.x === "number" ? target.x : startX;
      const targetY = typeof target.y === "number" ? target.y : startY;
      const x = startX + (targetX - startX) * progress;
      const y = startY + (targetY - startY) * progress;
      graph.updateItem(node, { x, y });
    });
    graph.paint();
    if (rawProgress < 1) {
      requestAnimationFrame(step);
    } else {
      graph.setAutoPaint(true);
      if (isCurrentToken(nodeAnimationTokens, graph, token) && onFinish) onFinish();
    }
  };
  requestAnimationFrame(step);
};

// src/layout/forceAlignLayout.ts
var forceAlignLayout = (graph, containerWidth) => {
  if (!graph || graph.destroyed) return;
  const allNodes = graph.getNodes();
  if (!allNodes.length) return;
  const isCore = (type) => type === "entity" || type === "relationship";
  const nodeMap = /* @__PURE__ */ new Map();
  const coreNodes = [];
  const attributeNodes = [];
  allNodes.forEach((n) => {
    const m = n.getModel();
    nodeMap.set(m.id, n);
    if (isCore(m.nodeType)) coreNodes.push(n);
    else if (m.nodeType === "attribute") attributeNodes.push(n);
  });
  if (!coreNodes.length) return;
  const typeOf = (id) => nodeMap.get(id)?.getModel().nodeType;
  const isEnt = (id) => typeOf(id) === "entity";
  const isRel = (id) => typeOf(id) === "relationship";
  const entityAttrs = /* @__PURE__ */ new Map();
  attributeNodes.forEach((attr) => {
    const pid = attr.getModel().parentEntity;
    if (!pid) return;
    if (!entityAttrs.has(pid)) entityAttrs.set(pid, []);
    entityAttrs.get(pid).push(attr);
  });
  const getRadius2 = (node) => {
    const b = node.getBBox();
    return Math.sqrt(b.width * b.width + b.height * b.height) / 2;
  };
  const coreAdj = /* @__PURE__ */ new Map();
  graph.getEdges().forEach((edge) => {
    const { source, target } = edge.getModel();
    if (!isCore(typeOf(source)) || !isCore(typeOf(target))) return;
    if (!coreAdj.has(source)) coreAdj.set(source, /* @__PURE__ */ new Set());
    if (!coreAdj.has(target)) coreAdj.set(target, /* @__PURE__ */ new Set());
    coreAdj.get(source).add(target);
    coreAdj.get(target).add(source);
  });
  if (!coreAdj.size) return;
  const visited = /* @__PURE__ */ new Set();
  const components = [];
  coreNodes.forEach((n) => {
    const id = n.getModel().id;
    if (visited.has(id)) return;
    const stack = [id];
    const comp = [];
    visited.add(id);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      (coreAdj.get(cur) || []).forEach((nb) => {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      });
    }
    components.push(comp);
  });
  const bfsFarthest = (start, allowed) => {
    const dist = /* @__PURE__ */ new Map();
    const prev = /* @__PURE__ */ new Map();
    const queue = [start];
    dist.set(start, 0);
    while (queue.length) {
      const cur = queue.shift();
      (coreAdj.get(cur) || []).forEach((nb) => {
        if (!allowed.has(nb) || dist.has(nb)) return;
        dist.set(nb, dist.get(cur) + 1);
        prev.set(nb, cur);
        queue.push(nb);
      });
    }
    let farthest = start;
    dist.forEach((d, id) => {
      if (d > dist.get(farthest)) farthest = id;
    });
    return { farthest, prev };
  };
  const findLongestPath = (ids) => {
    const allowed = new Set(ids);
    const { farthest: endA } = bfsFarthest(ids[0], allowed);
    const { farthest: endB, prev } = bfsFarthest(endA, allowed);
    const path = [];
    let cur = endB;
    while (cur !== void 0) {
      path.unshift(cur);
      cur = prev.get(cur);
    }
    return path.length ? path : [ids[0]];
  };
  const layoutComponent = (ids) => {
    const targets = /* @__PURE__ */ new Map();
    const radii = /* @__PURE__ */ new Map();
    ids.forEach((id) => radii.set(id, getRadius2(nodeMap.get(id))));
    const maxR = Math.max(...radii.values());
    const GAP = 48;
    const chainSpacing = Math.max(200, maxR * 2 + GAP);
    const mainPath = findLongestPath(ids);
    const mainPathSet = new Set(mainPath);
    const startX = -((mainPath.length - 1) * chainSpacing) / 2;
    mainPath.forEach((id, idx) => {
      targets.set(id, { x: startX + idx * chainSpacing, y: 0 });
    });
    const placed = new Set(mainPath);
    const buildRelSubtree = (relId, parentEntityId) => {
      placed.add(relId);
      const node = { id: relId, type: "rel", children: [] };
      const ents = Array.from(coreAdj.get(relId) || []).filter((id) => isEnt(id) && id !== parentEntityId && !placed.has(id)).sort();
      ents.forEach((eid) => {
        placed.add(eid);
        node.children.push(buildEntityNode(eid));
      });
      return node;
    };
    const buildEntityNode = (entityId) => {
      const node = { id: entityId, type: "entity", children: [] };
      const rels = Array.from(coreAdj.get(entityId) || []).filter((id) => isRel(id) && !placed.has(id)).sort();
      rels.forEach((rid) => {
        const relEnts = Array.from(coreAdj.get(rid) || []).filter(isEnt);
        const hasUnplacedEnt = relEnts.some((e) => e !== entityId && !placed.has(e));
        const isUnary = relEnts.length === 1;
        if (hasUnplacedEnt || isUnary) {
          node.children.push(buildRelSubtree(rid, entityId));
        }
      });
      return node;
    };
    const countLeaves = (node) => {
      if (!node.children.length) return 1;
      return node.children.reduce((s, c) => s + countLeaves(c), 0);
    };
    const unitWidth = maxR * 1.6 + GAP;
    const approxWidth = (n) => Math.max(1, countLeaves(n)) * unitWidth;
    const placeNode = (node, parentPos, parentR, angle, sectorSize, minDist) => {
      const myR = radii.get(node.id);
      const defaultDist = parentR + myR + GAP;
      const dist = Math.max(defaultDist, minDist || 0);
      const pos = {
        x: parentPos.x + Math.cos(angle) * dist,
        y: parentPos.y + Math.sin(angle) * dist
      };
      targets.set(node.id, pos);
      if (!node.children.length) return;
      const forwardLimit = Math.PI * 5 / 6;
      const effective = Math.min(sectorSize, forwardLimit);
      if (node.children.length === 1) {
        placeNode(node.children[0], pos, myR, angle, effective, 0);
        return;
      }
      const totalLeaves = node.children.reduce((s, c) => s + countLeaves(c), 0);
      const kids = node.children.map((c) => {
        const leaves = countLeaves(c);
        return { node: c, leaves, sector: effective * (leaves / totalLeaves) };
      });
      const needed = Math.max(
        ...kids.map((k) => approxWidth(k.node) / Math.max(k.sector, 0.05))
      );
      let cur = angle - effective / 2;
      kids.forEach((k) => {
        const cAngle = cur + k.sector / 2;
        placeNode(k.node, pos, myR, cAngle, k.sector, needed);
        cur += k.sector;
      });
    };
    const placeSubtreesAroundRoot = (rootId, subtrees) => {
      if (!subtrees.length) return;
      const rootPos = targets.get(rootId);
      const rootR = radii.get(rootId);
      const annotated = subtrees.map((st) => ({ st, leaves: countLeaves(st) })).sort((a, b) => b.leaves - a.leaves);
      const upper = [];
      let upLeaves = 0;
      const lower = [];
      let loLeaves = 0;
      annotated.forEach(({ st, leaves }) => {
        if (upLeaves <= loLeaves) {
          upper.push(st);
          upLeaves += leaves;
        } else {
          lower.push(st);
          loLeaves += leaves;
        }
      });
      const placeHalf = (sts, center) => {
        if (!sts.length) return;
        const totalSpan = Math.PI * 5 / 6;
        const total = sts.reduce((s, x) => s + countLeaves(x), 0);
        const needed = Math.max(
          ...sts.map((st) => {
            const leaves = countLeaves(st);
            const span = totalSpan * (leaves / total);
            return approxWidth(st) / Math.max(span, 0.05);
          })
        );
        let cur = center - totalSpan / 2;
        sts.forEach((st) => {
          const leaves = countLeaves(st);
          const span = totalSpan * (leaves / total);
          const a = cur + span / 2;
          placeNode(st, rootPos, rootR, a, span, needed);
          cur += span;
        });
      };
      placeHalf(upper, 3 * Math.PI / 2);
      placeHalf(lower, Math.PI / 2);
    };
    mainPath.filter(isEnt).forEach((eid) => {
      const branchRels = Array.from(coreAdj.get(eid) || []).filter((r) => isRel(r) && !placed.has(r)).sort();
      if (!branchRels.length) return;
      const subtrees = [];
      branchRels.forEach((rid) => {
        const relEnts = Array.from(coreAdj.get(rid) || []).filter(isEnt);
        const hasUnplacedEnt = relEnts.some((e) => e !== eid && !placed.has(e));
        const isUnary = relEnts.length === 1;
        if (hasUnplacedEnt || isUnary) {
          subtrees.push(buildRelSubtree(rid, eid));
        }
      });
      placeSubtreesAroundRoot(eid, subtrees);
    });
    mainPath.filter(isRel).forEach((rid) => {
      const extraEnts = Array.from(coreAdj.get(rid) || []).filter((e) => isEnt(e) && !placed.has(e)).sort();
      if (!extraEnts.length) return;
      const subtrees = extraEnts.map((eid) => {
        placed.add(eid);
        return buildEntityNode(eid);
      });
      placeSubtreesAroundRoot(rid, subtrees);
    });
    ids.forEach((id) => {
      if (placed.has(id)) return;
      if (!isEnt(id)) return;
      placed.add(id);
      const subtree = buildEntityNode(id);
      const anchorId = Array.from(coreAdj.get(id) || []).find((x) => placed.has(x));
      if (anchorId) {
        const aPos = targets.get(anchorId);
        const aR = radii.get(anchorId);
        placeNode(subtree, aPos, aR, Math.PI / 2, Math.PI * 2 / 3, 0);
      } else {
        targets.set(id, { x: 0, y: 0 });
        placeNode(subtree, { x: 0, y: 0 }, 0, Math.PI / 2, Math.PI * 2 / 3, 0);
      }
    });
    ids.forEach((id) => {
      if (placed.has(id)) return;
      if (!isRel(id)) return;
      const ents = Array.from(coreAdj.get(id) || []).filter(isEnt);
      const placedEnts = ents.filter((e) => targets.has(e));
      if (!placedEnts.length) return;
      const myR = radii.get(id);
      if (placedEnts.length === 1) {
        const p = targets.get(placedEnts[0]);
        const r = radii.get(placedEnts[0]);
        targets.set(id, { x: p.x, y: p.y + r + myR + GAP });
      } else {
        let mx = 0, my = 0;
        placedEnts.forEach((e) => {
          const p = targets.get(e);
          mx += p.x;
          my += p.y;
        });
        mx /= placedEnts.length;
        my /= placedEnts.length;
        const p1 = targets.get(placedEnts[0]);
        const p2 = targets.get(placedEnts[1]);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        let perpX = -dy / len, perpY = dx / len;
        const flip = deterministicHash(id) % 2 === 0 ? 1 : -1;
        perpX *= flip;
        perpY *= flip;
        const off = Math.max(myR + 60, len * 0.22);
        targets.set(id, { x: mx + perpX * off, y: my + perpY * off });
      }
      placed.add(id);
    });
    ids.forEach((id) => {
      if (!targets.has(id)) {
        const m = nodeMap.get(id)?.getModel();
        targets.set(id, { x: m?.x || 0, y: m?.y || 0 });
      }
    });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    targets.forEach((pos, id) => {
      const r = radii.get(id) || 30;
      minX = Math.min(minX, pos.x - r);
      maxX = Math.max(maxX, pos.x + r);
      minY = Math.min(minY, pos.y - r);
      maxY = Math.max(maxY, pos.y + r);
    });
    return { targets, bounds: { minX, maxX, minY, maxY }, mainPathSet };
  };
  const componentLayouts = components.map(layoutComponent);
  const globalTargets = /* @__PURE__ */ new Map();
  const componentGap = 240;
  let cursorX = componentGap;
  let cursorY = componentGap;
  let rowHeight = 0;
  const mainChainIds = /* @__PURE__ */ new Set();
  componentLayouts.forEach((layout) => {
    const { minX, maxX, minY, maxY } = layout.bounds;
    const width = maxX - minX + componentGap;
    const height = maxY - minY + componentGap;
    if (cursorX + width > containerWidth - componentGap / 2) {
      cursorX = componentGap;
      cursorY += rowHeight + componentGap;
      rowHeight = 0;
    }
    const offsetX = cursorX - minX;
    const offsetY = cursorY - minY;
    layout.targets.forEach((pos, id) => {
      globalTargets.set(id, { x: pos.x + offsetX, y: pos.y + offsetY });
    });
    layout.mainPathSet.forEach((id) => mainChainIds.add(id));
    cursorX += width;
    rowHeight = Math.max(rowHeight, height);
  });
  const mainAnchorPos = /* @__PURE__ */ new Map();
  mainChainIds.forEach((id) => {
    const p = globalTargets.get(id);
    if (p) mainAnchorPos.set(id, { ...p });
  });
  entityAttrs.forEach((attrs, eid) => {
    const center = globalTargets.get(eid);
    if (!center || !attrs.length) return;
    const entityR = getRadius2(nodeMap.get(eid));
    const attrR = Math.max(...attrs.map(getRadius2));
    const ring = entityR + attrR + 8;
    const relNeighbors = Array.from(coreAdj.get(eid) || []).filter(isRel);
    const relAngles = relNeighbors.map((rid) => {
      const rp = globalTargets.get(rid);
      return rp ? normalizeAngle(Math.atan2(rp.y - center.y, rp.x - center.x)) : null;
    }).filter((a) => a !== null);
    const sortedRels = relAngles.slice().sort((a, b) => a - b);
    const arcs = [];
    if (!sortedRels.length) {
      arcs.push({ start: 0, length: Math.PI * 2, count: 0 });
    } else {
      const pad = 0.25;
      for (let i = 0; i < sortedRels.length; i++) {
        const a = sortedRels[i];
        const b = sortedRels[(i + 1) % sortedRels.length] + (i === sortedRels.length - 1 ? Math.PI * 2 : 0);
        const rawStart = a + pad;
        const rawEnd = b - pad;
        const len = rawEnd - rawStart;
        if (len > 0.05) arcs.push({ start: rawStart, length: len, count: 0 });
      }
      if (!arcs.length) arcs.push({ start: 0, length: Math.PI * 2, count: 0 });
    }
    const totalLen = arcs.reduce((s, a) => s + a.length, 0);
    const sortedAttrs = attrs.slice().sort((a, b) => a.getModel().id.localeCompare(b.getModel().id));
    const n = sortedAttrs.length;
    let remaining = n;
    arcs.forEach((arc) => {
      arc.count = Math.floor(arc.length / totalLen * n);
      remaining -= arc.count;
    });
    const bySize = arcs.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < remaining; i++) bySize[i % bySize.length].count += 1;
    let attrIdx = 0;
    arcs.forEach((arc) => {
      for (let k = 1; k <= arc.count; k++) {
        const ratio = k / (arc.count + 1);
        const angle = normalizeAngle(arc.start + arc.length * ratio);
        const attrNode = sortedAttrs[attrIdx++];
        globalTargets.set(attrNode.getModel().id, {
          x: center.x + Math.cos(angle) * ring,
          y: center.y + Math.sin(angle) * ring
        });
      }
    });
    while (attrIdx < n) {
      const attrNode = sortedAttrs[attrIdx];
      const angle = attrIdx / n * Math.PI * 2;
      globalTargets.set(attrNode.getModel().id, {
        x: center.x + Math.cos(angle) * ring,
        y: center.y + Math.sin(angle) * ring
      });
      attrIdx++;
    }
  });
  allNodes.forEach((n) => {
    const m = n.getModel();
    if (!globalTargets.has(m.id)) {
      globalTargets.set(m.id, { x: m.x || 0, y: m.y || 0 });
    }
  });
  const resolveCoreOverlaps = () => {
    const coreIds = coreNodes.map((n) => n.getModel().id);
    const meta = coreIds.map((id) => ({ id, r: getRadius2(nodeMap.get(id)) }));
    for (let iter = 0; iter < 160; iter++) {
      let moved = 0;
      for (let i = 0; i < meta.length; i++) {
        for (let j = i + 1; j < meta.length; j++) {
          const a = meta[i], b = meta[j];
          const pa = globalTargets.get(a.id);
          const pb = globalTargets.get(b.id);
          if (!pa || !pb) continue;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const minDist = a.r + b.r + 16;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const aLocked = mainChainIds.has(a.id);
            const bLocked = mainChainIds.has(b.id);
            const pushA = aLocked ? 0 : overlap / (bLocked ? 1 : 2);
            const pushB = bLocked ? 0 : overlap / (aLocked ? 1 : 2);
            const nx = dx / dist, ny = dy / dist;
            pa.x -= nx * pushA;
            pa.y -= ny * pushA;
            pb.x += nx * pushB;
            pb.y += ny * pushB;
            moved = Math.max(moved, Math.max(pushA, pushB));
          }
        }
      }
      if (moved < 0.5) break;
    }
  };
  resolveCoreOverlaps();
  mainAnchorPos.forEach((pos, id) => {
    globalTargets.set(id, { ...pos });
  });
  animateNodesToTargets(graph, globalTargets, 800, () => {
    graph.refreshPositions();
    setTimeout(() => smoothFitView(graph, 700, "easeOutCubic"), 120);
  });
};

// src/layout/arrangeLayout.ts
var buildGrid = (items, cellSize) => {
  const grid = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    const cx = Math.floor(item.pos.x / cellSize);
    const cy = Math.floor(item.pos.y / cellSize);
    const key = cx + "," + cy;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(item);
  });
  return grid;
};
var forEachNeighbor = (grid, cellSize, item, cb) => {
  const cx = Math.floor(item.pos.x / cellSize);
  const cy = Math.floor(item.pos.y / cellSize);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get(cx + ox + "," + (cy + oy));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) cb(bucket[k]);
    }
  }
};
var segmentsCross = (a1, a2, b1, b2) => {
  const share = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (share(a1, b1) || share(a1, b2) || share(a2, b1) || share(a2, b2)) return false;
  const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = cross(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
};
var arrangeLayout = (graph) => {
  if (!graph || graph.destroyed) return;
  const nodes = graph.getNodes();
  if (!nodes.length) return;
  const targets = /* @__PURE__ */ new Map();
  const nodeMap = /* @__PURE__ */ new Map();
  nodes.forEach((n) => nodeMap.set(n.getModel().id, n));
  const relAnchors = /* @__PURE__ */ new Map();
  const relRadii = /* @__PURE__ */ new Map();
  const entityNodes = nodes.filter((n) => n.getModel().nodeType === "entity");
  const attributeNodes = nodes.filter((n) => n.getModel().nodeType === "attribute");
  const relationshipNodes = nodes.filter((n) => n.getModel().nodeType === "relationship");
  const getRadius2 = (node) => {
    const bbox = node.getBBox();
    return Math.sqrt(bbox.width * bbox.width + bbox.height * bbox.height) / 2;
  };
  const getAxisMax = (node) => {
    const bbox = node.getBBox();
    return Math.max(bbox.width, bbox.height) / 2;
  };
  const rectBoundary = (rx, ry, cosT, sinT) => {
    const ac = Math.abs(cosT);
    const as = Math.abs(sinT);
    if (ac < 1e-9) return ry;
    if (as < 1e-9) return rx;
    return Math.min(rx / ac, ry / as);
  };
  const ellipseBoundary = (rx, ry, cosT, sinT) => {
    if (rx <= 0 || ry <= 0) return 0;
    const denom = Math.sqrt(ry * ry * cosT * cosT + rx * rx * sinT * sinT);
    return denom > 1e-9 ? rx * ry / denom : 0;
  };
  const diamondBoundary = (rx, ry, cosT, sinT) => {
    if (rx <= 0 || ry <= 0) return 0;
    const denom = Math.abs(cosT) / rx + Math.abs(sinT) / ry;
    return denom > 1e-9 ? 1 / denom : 0;
  };
  const normalizeAngle2 = (a) => {
    let angle = a % (Math.PI * 2);
    if (angle < 0) angle += Math.PI * 2;
    return angle;
  };
  const relationshipConnections = /* @__PURE__ */ new Map();
  graph.getEdges().forEach((edge) => {
    const { source, target } = edge.getModel();
    const sourceNode = nodeMap.get(source);
    const targetNode = nodeMap.get(target);
    if (!sourceNode || !targetNode) return;
    const sType = sourceNode.getModel().nodeType;
    const tType = targetNode.getModel().nodeType;
    if (sType === "relationship" && tType === "entity") {
      if (!relationshipConnections.has(source)) relationshipConnections.set(source, /* @__PURE__ */ new Set());
      relationshipConnections.get(source).add(targetNode);
    } else if (tType === "relationship" && sType === "entity") {
      if (!relationshipConnections.has(target)) relationshipConnections.set(target, /* @__PURE__ */ new Set());
      relationshipConnections.get(target).add(sourceNode);
    }
  });
  const entityInfo = /* @__PURE__ */ new Map();
  entityNodes.forEach(
    (e) => entityInfo.set(e.getModel().id, { node: e, attrs: [], rels: [], satellites: [] })
  );
  attributeNodes.forEach((a) => {
    const pid = a.getModel().parentEntity;
    const info = entityInfo.get(pid);
    if (info) {
      info.attrs.push(a);
      info.satellites.push({ node: a, type: "attr" });
    }
  });
  relationshipNodes.forEach((r) => {
    const set = relationshipConnections.get(r.getModel().id);
    if (set) {
      const connected = Array.from(set);
      connected.forEach((entityNode) => {
        const info = entityInfo.get(entityNode.getModel().id);
        if (!info) return;
        const other = connected.find((n) => n !== entityNode) || null;
        info.rels.push({ relNode: r, otherEntity: other });
        info.satellites.push({ node: r, type: "rel", otherEntity: other });
      });
    }
  });
  const entityPositions = /* @__PURE__ */ new Map();
  entityNodes.forEach((n) => {
    const m = n.getModel();
    entityPositions.set(m.id, { x: m.x, y: m.y });
  });
  const gapAngle = 1.3;
  const adaptiveGap = (K) => K > 0 ? Math.min(gapAngle, Math.PI / K) : gapAngle;
  const halfGap = gapAngle / 2;
  const baseRing = /* @__PURE__ */ new Map();
  const systemRadius = /* @__PURE__ */ new Map();
  const entityRadii = /* @__PURE__ */ new Map();
  const maxSatelliteRadii = /* @__PURE__ */ new Map();
  const orbitalCounts = /* @__PURE__ */ new Map();
  const binRelCounts = /* @__PURE__ */ new Map();
  const entityHalfX = /* @__PURE__ */ new Map();
  const entityHalfY = /* @__PURE__ */ new Map();
  const orbitHalfX = /* @__PURE__ */ new Map();
  const orbitHalfY = /* @__PURE__ */ new Map();
  const tangentialFloors = /* @__PURE__ */ new Map();
  entityInfo.forEach((info) => {
    const id = info.node.getModel().id;
    const entityRadius = getRadius2(info.node);
    const entityAxisMax = getAxisMax(info.node);
    const ebbox = info.node.getBBox();
    const ehx = ebbox.width / 2;
    const ehy = ebbox.height / 2;
    entityHalfX.set(id, ehx);
    entityHalfY.set(id, ehy);
    entityRadii.set(id, entityRadius);
    const orbitalSatellites = info.satellites.filter((s) => s.type === "attr" || !s.otherEntity);
    const orbitalCount = orbitalSatellites.length;
    const binRelCount = info.satellites.length - orbitalCount;
    orbitalCounts.set(id, orbitalCount);
    binRelCounts.set(id, binRelCount);
    const maxSatelliteRadius = orbitalCount > 0 ? Math.max(...orbitalSatellites.map((s) => getRadius2(s.node))) : 0;
    const maxSatAxisMax = orbitalCount > 0 ? Math.max(...orbitalSatellites.map((s) => getAxisMax(s.node))) : 0;
    let ohx = 0, ohy = 0;
    orbitalSatellites.forEach((s) => {
      const sb = s.node.getBBox();
      if (sb.width / 2 > ohx) ohx = sb.width / 2;
      if (sb.height / 2 > ohy) ohy = sb.height / 2;
    });
    orbitHalfX.set(id, ohx);
    orbitHalfY.set(id, ohy);
    maxSatelliteRadii.set(id, maxSatelliteRadius);
    const eg = adaptiveGap(binRelCount);
    const usableAngle = Math.max(2 * Math.PI - binRelCount * eg, Math.PI / 2);
    const sumExtents = orbitalSatellites.reduce((sum, s) => {
      const sb = s.node.getBBox();
      return sum + Math.max(sb.width, sb.height) + 8;
    }, 0);
    let tangentialFloor = 0;
    if (orbitalCount > 0) {
      if (binRelCount > 0) {
        const segmentSize = usableAngle / binRelCount;
        const maxPerSegment = Math.max(1, Math.ceil(orbitalCount / binRelCount));
        const avgExtent = sumExtents / orbitalCount;
        tangentialFloor = avgExtent * maxPerSegment / segmentSize;
      } else {
        tangentialFloor = sumExtents / (2 * Math.PI);
      }
    }
    tangentialFloors.set(id, tangentialFloor);
    let ringR = orbitalCount > 0 ? Math.max(ehx + ohx + 8, ehy + ohy + 8, tangentialFloor) : entityRadius;
    baseRing.set(id, ringR);
    systemRadius.set(id, ringR + maxSatelliteRadius);
  });
  const clearanceGap = 12;
  const minEntityRelationGap = 28;
  const orbitR = (ehx, ehy, ohx, ohy, cosT, sinT, floor) => {
    const eOut = rectBoundary(ehx, ehy, cosT, sinT);
    const oIn = ellipseBoundary(ohx, ohy, cosT, sinT);
    return Math.max(eOut + oIn + 8, floor);
  };
  const computeClosestAngle = (id) => {
    const N = orbitalCounts.get(id) ?? 0;
    const K = binRelCounts.get(id) ?? 0;
    if (N <= 0 || K <= 0) return Math.PI / 2;
    const eg = adaptiveGap(K);
    const usable = Math.max(2 * Math.PI - K * eg, Math.PI / 2);
    const segmentSize = usable / K;
    const maxPerSegment = Math.max(1, Math.ceil(N / K));
    return eg / 2 + segmentSize / (2 * maxPerSegment);
  };
  const getRelHalfSize = (relNode) => {
    const b = relNode.getBBox();
    return { x: b.width / 2, y: b.height / 2 };
  };
  const computeEntityRelMinCenterDistance = (id, relNode, ux, uy) => {
    const ehx = entityHalfX.get(id) ?? 30;
    const ehy = entityHalfY.get(id) ?? 30;
    const rh = getRelHalfSize(relNode);
    return rectBoundary(ehx, ehy, ux, uy) + diamondBoundary(rh.x, rh.y, ux, uy) + minEntityRelationGap;
  };
  const computePairGeometryMinDistance = (idA, idB, relNode, posA, posB) => {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    return computeEntityRelMinCenterDistance(idA, relNode, ux, uy) + computeEntityRelMinCenterDistance(idB, relNode, -ux, -uy);
  };
  const computeEqualGapRelationshipAnchor = (idA, idB, relNode, posA, posB) => {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const aEntity = rectBoundary(entityHalfX.get(idA) ?? 30, entityHalfY.get(idA) ?? 30, ux, uy);
    const bEntity = rectBoundary(entityHalfX.get(idB) ?? 30, entityHalfY.get(idB) ?? 30, -ux, -uy);
    const rh = getRelHalfSize(relNode);
    const relToA = diamondBoundary(rh.x, rh.y, -ux, -uy);
    const relToB = diamondBoundary(rh.x, rh.y, ux, uy);
    const free = dist - aEntity - relToA - bEntity - relToB;
    const gap = Math.max(minEntityRelationGap, free / 2);
    const minFromA = aEntity + relToA + minEntityRelationGap;
    const maxFromA = dist - bEntity - relToB - minEntityRelationGap;
    const idealFromA = aEntity + relToA + gap;
    const distFromA = Math.min(Math.max(idealFromA, minFromA), Math.max(minFromA, maxFromA));
    return {
      x: posA.x + ux * distFromA,
      y: posA.y + uy * distFromA
    };
  };
  const computeLegacyAttributeClearance = (id, relR) => {
    const ehx = entityHalfX.get(id) ?? 30;
    const ehy = entityHalfY.get(id) ?? 30;
    const ohx = orbitHalfX.get(id) ?? 0;
    const ohy = orbitHalfY.get(id) ?? 0;
    const orbitalCount = orbitalCounts.get(id) ?? 0;
    const binRelCount = binRelCounts.get(id) ?? 0;
    const floor = tangentialFloors.get(id) ?? 0;
    const maxSatR = maxSatelliteRadii.get(id) ?? 0;
    const entityR = entityRadii.get(id) ?? 30;
    const entityTerm = entityR + relR + clearanceGap;
    if (maxSatR <= 0 || orbitalCount <= 0 || binRelCount <= 0) return entityTerm;
    const blockR = maxSatR + relR + clearanceGap;
    const closestAngle = computeClosestAngle(id);
    const cosA = Math.cos(closestAngle);
    const sinA = Math.sin(closestAngle);
    const r = orbitR(ehx, ehy, ohx, ohy, cosA, sinA, floor);
    const perp = sinA * r;
    const along = cosA * r;
    if (blockR <= perp) return entityTerm;
    const attrTerm = along + Math.sqrt(blockR * blockR - perp * perp);
    return Math.max(entityTerm, attrTerm);
  };
  const computePairAttrAttrSum = (idA, idB) => {
    const orbA = orbitalCounts.get(idA) ?? 0;
    const orbB = orbitalCounts.get(idB) ?? 0;
    const brA = binRelCounts.get(idA) ?? 0;
    const brB = binRelCounts.get(idB) ?? 0;
    const msA = maxSatelliteRadii.get(idA) ?? 0;
    const msB = maxSatelliteRadii.get(idB) ?? 0;
    if (msA <= 0 || msB <= 0 || orbA <= 0 || orbB <= 0 || brA <= 0 || brB <= 0) return 0;
    const thetaA = computeClosestAngle(idA);
    const thetaB = computeClosestAngle(idB);
    const cosA = Math.cos(thetaA), sinA = Math.sin(thetaA);
    const cosB = Math.cos(thetaB), sinB = Math.sin(thetaB);
    const rA = orbitR(
      entityHalfX.get(idA) ?? 30,
      entityHalfY.get(idA) ?? 30,
      orbitHalfX.get(idA) ?? 0,
      orbitHalfY.get(idA) ?? 0,
      cosA,
      sinA,
      tangentialFloors.get(idA) ?? 0
    );
    const rB = orbitR(
      entityHalfX.get(idB) ?? 30,
      entityHalfY.get(idB) ?? 30,
      orbitHalfX.get(idB) ?? 0,
      orbitHalfY.get(idB) ?? 0,
      cosB,
      sinB,
      tangentialFloors.get(idB) ?? 0
    );
    const blockR = msA + msB + 8;
    const alongA = cosA * rA;
    const alongB = cosB * rB;
    const perpDiff = sinA * rA - sinB * rB;
    const radial = Math.sqrt(Math.max(0, blockR * blockR - perpDiff * perpDiff));
    return alongA + alongB + radial;
  };
  const relationshipPairs = [];
  relationshipNodes.forEach((relNode) => {
    const set = relationshipConnections.get(relNode.getModel().id);
    if (!set || set.size !== 2) return;
    const [entityA, entityB] = Array.from(set.values());
    relationshipPairs.push({
      idA: entityA.getModel().id,
      idB: entityB.getModel().id,
      relNode
    });
  });
  const pairKey = (idA, idB) => idA < idB ? idA + "|" + idB : idB + "|" + idA;
  const connectedPairKeys = /* @__PURE__ */ new Set();
  const pairDesired = /* @__PURE__ */ new Map();
  relationshipPairs.forEach((p) => {
    const attrAttr = computePairAttrAttrSum(p.idA, p.idB);
    const posA = entityPositions.get(p.idA);
    const posB = entityPositions.get(p.idB);
    const geometryMin = posA && posB ? computePairGeometryMinDistance(p.idA, p.idB, p.relNode, posA, posB) : computeLegacyAttributeClearance(p.idA, getRadius2(p.relNode)) + computeLegacyAttributeClearance(p.idB, getRadius2(p.relNode));
    const want = Math.max(geometryMin, attrAttr);
    const k = pairKey(p.idA, p.idB);
    connectedPairKeys.add(k);
    const prev = pairDesired.get(k) ?? 0;
    if (want > prev) pairDesired.set(k, want);
  });
  const entityNeighbors = /* @__PURE__ */ new Map();
  entityNodes.forEach((n) => entityNeighbors.set(n.getModel().id, /* @__PURE__ */ new Set()));
  relationshipPairs.forEach((pair) => {
    entityNeighbors.get(pair.idA)?.add(pair.idB);
    entityNeighbors.get(pair.idB)?.add(pair.idA);
  });
  const safeGap = 35;
  const entityIds = Array.from(entityPositions.keys());
  const maxSysR = entityIds.length ? Math.max(...entityIds.map((id) => systemRadius.get(id) || 60)) : 80;
  const entityCellSize = Math.max(120, maxSysR * 2 + safeGap);
  for (let iter = 0; iter < 300; iter++) {
    let maxMove = 0;
    const deadbandRatio = 1.5;
    relationshipPairs.forEach((pair) => {
      const posA = entityPositions.get(pair.idA);
      const posB = entityPositions.get(pair.idB);
      if (!posA || !posB) return;
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.hypot(dx, dy) || 1;
      const desired = pairDesired.get(pairKey(pair.idA, pair.idB)) ?? 0;
      if (!desired) return;
      const upperLimit = desired * deadbandRatio;
      let target;
      let factor;
      if (dist < desired - 1) {
        target = desired;
        factor = 0.2;
      } else if (dist > upperLimit + 1) {
        target = upperLimit;
        factor = 0.05;
      } else {
        return;
      }
      const diff = target - dist;
      const nx = dx / dist;
      const ny = dy / dist;
      const move2 = diff * factor / 2;
      posA.x -= nx * move2;
      posA.y -= ny * move2;
      posB.x += nx * move2;
      posB.y += ny * move2;
      maxMove = Math.max(maxMove, Math.abs(move2));
    });
    const entityItems = entityIds.map((id) => ({
      id,
      pos: entityPositions.get(id),
      r: systemRadius.get(id)
    }));
    const grid = buildGrid(entityItems, entityCellSize);
    for (let i = 0; i < entityItems.length; i++) {
      const a = entityItems[i];
      forEachNeighbor(grid, entityCellSize, a, (b) => {
        if (b.id <= a.id) return;
        if (connectedPairKeys.has(pairKey(a.id, b.id))) return;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dist = Math.hypot(dx, dy) || 1;
        const minDesc = a.r + b.r + safeGap;
        if (dist < minDesc) {
          const overlap = minDesc - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const move2 = overlap * 0.25;
          a.pos.x -= nx * move2;
          a.pos.y -= ny * move2;
          b.pos.x += nx * move2;
          b.pos.y += ny * move2;
          if (move2 > maxMove) maxMove = move2;
        }
      });
    }
    entityIds.forEach((centerId) => {
      const neighbors = entityNeighbors.get(centerId);
      if (!neighbors || neighbors.size < 2) return;
      const centerPos = entityPositions.get(centerId);
      if (!centerPos) return;
      const nArr = Array.from(neighbors);
      const idealStep = Math.PI * 2 / nArr.length;
      const activation = idealStep * 0.5;
      for (let i = 0; i < nArr.length; i++) {
        const pi = entityPositions.get(nArr[i]);
        if (!pi) continue;
        const dxi = pi.x - centerPos.x;
        const dyi = pi.y - centerPos.y;
        const di = Math.hypot(dxi, dyi) || 1;
        const ai = Math.atan2(dyi, dxi);
        for (let j = i + 1; j < nArr.length; j++) {
          const pj = entityPositions.get(nArr[j]);
          if (!pj) continue;
          if (connectedPairKeys.has(pairKey(nArr[i], nArr[j]))) continue;
          const dxj = pj.x - centerPos.x;
          const dyj = pj.y - centerPos.y;
          const dj = Math.hypot(dxj, dyj) || 1;
          const aj = Math.atan2(dyj, dxj);
          let diff = aj - ai;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff <= -Math.PI) diff += Math.PI * 2;
          const absDiff = Math.abs(diff);
          if (absDiff >= activation) continue;
          const shortfall = activation - absDiff;
          const sign = diff >= 0 ? 1 : -1;
          let arc = shortfall * Math.min(di, dj) * 0.02;
          if (arc > 2.5) arc = 2.5;
          const dai = arc / di * -sign;
          const daj = arc / dj * sign;
          const cosI = Math.cos(dai), sinI = Math.sin(dai);
          const newDxi = dxi * cosI - dyi * sinI;
          const newDyi = dxi * sinI + dyi * cosI;
          pi.x = centerPos.x + newDxi;
          pi.y = centerPos.y + newDyi;
          const cosJ = Math.cos(daj), sinJ = Math.sin(daj);
          const newDxj = dxj * cosJ - dyj * sinJ;
          const newDyj = dxj * sinJ + dyj * cosJ;
          pj.x = centerPos.x + newDxj;
          pj.y = centerPos.y + newDyj;
          if (arc > maxMove) maxMove = arc;
        }
      }
    });
    if (maxMove < 0.5) break;
  }
  const countCrossings = () => {
    let total = 0;
    for (let i = 0; i < relationshipPairs.length; i++) {
      const pi = relationshipPairs[i];
      const a1 = entityPositions.get(pi.idA);
      const a2 = entityPositions.get(pi.idB);
      if (!a1 || !a2) continue;
      for (let j = i + 1; j < relationshipPairs.length; j++) {
        const pj = relationshipPairs[j];
        if (pi.idA === pj.idA || pi.idA === pj.idB || pi.idB === pj.idA || pi.idB === pj.idB)
          continue;
        const b1 = entityPositions.get(pj.idA);
        const b2 = entityPositions.get(pj.idB);
        if (!b1 || !b2) continue;
        if (segmentsCross(a1, a2, b1, b2)) total++;
      }
    }
    return total;
  };
  if (relationshipPairs.length >= 2 && entityIds.length >= 2) {
    let currentCrossings = countCrossings();
    if (currentCrossings > 0) {
      const maxSwapPasses = 8;
      for (let pass = 0; pass < maxSwapPasses && currentCrossings > 0; pass++) {
        let improved = false;
        for (let i = 0; i < entityIds.length && currentCrossings > 0; i++) {
          for (let j = i + 1; j < entityIds.length; j++) {
            const idA = entityIds[i];
            const idB = entityIds[j];
            const pa = entityPositions.get(idA);
            const pb = entityPositions.get(idB);
            if (!pa || !pb) continue;
            const tmpX = pa.x, tmpY = pa.y;
            pa.x = pb.x;
            pa.y = pb.y;
            pb.x = tmpX;
            pb.y = tmpY;
            const newCrossings = countCrossings();
            if (newCrossings < currentCrossings) {
              currentCrossings = newCrossings;
              improved = true;
              if (currentCrossings === 0) break;
            } else {
              pb.x = pa.x;
              pb.y = pa.y;
              pa.x = tmpX;
              pa.y = tmpY;
            }
          }
        }
        if (!improved) break;
      }
    }
  }
  const ensureRelationshipClearance = () => {
    relationshipNodes.forEach((relNode) => {
      const relId = relNode.getModel().id;
      const connected = relationshipConnections.get(relId);
      if (!connected || connected.size !== 2) return;
      const [entityA, entityB] = Array.from(connected.values());
      const idA = entityA.getModel().id;
      const idB = entityB.getModel().id;
      const posA = entityPositions.get(idA);
      const posB = entityPositions.get(idB);
      if (!posA || !posB) return;
      const dx = posB.x - posA.x;
      const dy = posB.y - posA.y;
      const dist = Math.hypot(dx, dy) || 1;
      const requiredDist = Math.max(
        pairDesired.get(pairKey(idA, idB)) ?? 0,
        computePairGeometryMinDistance(idA, idB, relNode, posA, posB)
      );
      if (!requiredDist || dist >= requiredDist) return;
      const missing = requiredDist - dist;
      const nx = dx / dist;
      const ny = dy / dist;
      posA.x -= nx * missing / 2;
      posA.y -= ny * missing / 2;
      posB.x += nx * missing / 2;
      posB.y += ny * missing / 2;
    });
  };
  ensureRelationshipClearance();
  ensureRelationshipClearance();
  ensureRelationshipClearance();
  entityPositions.forEach((pos, id) => targets.set(id, { ...pos }));
  const entityOrbitRadius = /* @__PURE__ */ new Map();
  entityInfo.forEach((info) => {
    const { node, satellites } = info;
    const model = node.getModel();
    const center = entityPositions.get(model.id) || { x: model.x, y: model.y };
    const ringRadius = baseRing.get(model.id);
    entityOrbitRadius.set(model.id, ringRadius);
    if (!satellites.length) return;
    const avoidAngles = [];
    satellites.forEach((s) => {
      if (s.type === "rel" && s.otherEntity) {
        const otherPos = entityPositions.get(s.otherEntity.getModel().id);
        if (otherPos) {
          const angle = normalizeAngle2(Math.atan2(otherPos.y - center.y, otherPos.x - center.x));
          avoidAngles.push(angle);
        }
      }
    });
    const halfGapEntity = adaptiveGap(avoidAngles.length) / 2;
    let segments = [];
    if (!avoidAngles.length) {
      segments.push({ start: 0, end: Math.PI * 2 });
    } else {
      const sortedAngles = avoidAngles.slice().sort((a, b) => a - b);
      const total = Math.PI * 2;
      for (let i = 0; i < sortedAngles.length; i++) {
        const curr = sortedAngles[i];
        const next = sortedAngles[(i + 1) % sortedAngles.length] + (i === sortedAngles.length - 1 ? total : 0);
        const start = curr + halfGapEntity;
        const end = next - halfGapEntity;
        if (end > start) segments.push({ start, end });
      }
    }
    const totalFree = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (totalFree <= 0) {
      segments = [{ start: 0, end: Math.PI * 2 }];
    }
    const orbitalSatellites = satellites.filter(
      (s) => s.type === "attr" || s.type === "rel" && !s.otherEntity
    );
    if (!orbitalSatellites.length) return;
    const sortedSatellites = orbitalSatellites.slice().sort((a, b) => {
      const ma = a.node.getModel();
      const mb = b.node.getModel();
      const angleA = normalizeAngle2(Math.atan2(ma.y - center.y, ma.x - center.x));
      const angleB = normalizeAngle2(Math.atan2(mb.y - center.y, mb.x - center.x));
      return angleA - angleB;
    });
    const totalCount = sortedSatellites.length;
    const totalAngle = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    const segCounts = segments.map(
      (s) => Math.max(0, Math.round(totalCount * (s.end - s.start) / totalAngle))
    );
    let allocated = segCounts.reduce((sum, c) => sum + c, 0);
    while (allocated < totalCount) {
      let maxIdx = 0;
      let maxLen = -Infinity;
      segments.forEach((s, idx) => {
        if (s.end - s.start > maxLen) {
          maxLen = s.end - s.start;
          maxIdx = idx;
        }
      });
      segCounts[maxIdx]++;
      allocated++;
    }
    while (allocated > totalCount) {
      for (let i = segCounts.length - 1; i >= 0; i--) {
        if (segCounts[i] > 0) {
          segCounts[i]--;
          allocated--;
          break;
        }
      }
    }
    const ehx = entityHalfX.get(model.id) ?? 30;
    const ehy = entityHalfY.get(model.id) ?? 30;
    const floor = tangentialFloors.get(model.id) ?? 0;
    let nodeIdx = 0;
    segments.forEach((s, idx) => {
      const count = segCounts[idx];
      if (!count) return;
      const step = (s.end - s.start) / count;
      for (let i = 0; i < count; i++) {
        const angle = s.start + step * (i + 0.5);
        const useAngle = normalizeAngle2(angle);
        const cosA = Math.cos(useAngle);
        const sinA = Math.sin(useAngle);
        const satellite = sortedSatellites[nodeIdx++];
        if (!satellite) continue;
        const sb = satellite.node.getBBox();
        const shx = sb.width / 2;
        const shy = sb.height / 2;
        const eOut = rectBoundary(ehx, ehy, cosA, sinA);
        const sIn = ellipseBoundary(shx, shy, cosA, sinA);
        const r = Math.max(eOut + sIn + 8, floor);
        const targetX = center.x + r * cosA;
        const targetY = center.y + r * sinA;
        targets.set(satellite.node.getModel().id, { x: targetX, y: targetY });
      }
    });
    targets.set(model.id, { x: center.x, y: center.y });
  });
  relationshipNodes.forEach((relNode) => {
    const relId = relNode.getModel().id;
    const connectedEntities = relationshipConnections.get(relId);
    if (connectedEntities && connectedEntities.size === 2) {
      const [entityA, entityB] = Array.from(connectedEntities.values());
      const idA = entityA.getModel().id;
      const idB = entityB.getModel().id;
      const posA = entityPositions.get(idA);
      const posB = entityPositions.get(idB);
      if (!posA || !posB) return;
      const relR = getRadius2(relNode);
      const anchorPos = computeEqualGapRelationshipAnchor(idA, idB, relNode, posA, posB);
      targets.set(relId, anchorPos);
      relAnchors.set(relId, anchorPos);
      relRadii.set(relId, relR);
    }
  });
  const groupedRelations = /* @__PURE__ */ new Map();
  relationshipNodes.forEach((relNode) => {
    const relId = relNode.getModel().id;
    const connected = relationshipConnections.get(relId);
    if (!connected || connected.size !== 2) return;
    const [entityA, entityB] = Array.from(connected.values());
    const idA = entityA.getModel().id;
    const idB = entityB.getModel().id;
    const key = idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;
    if (!groupedRelations.has(key)) groupedRelations.set(key, []);
    groupedRelations.get(key).push({
      relNode,
      relRadius: getRadius2(relNode),
      entities: [entityA, entityB]
    });
  });
  groupedRelations.forEach((list) => {
    if (list.length <= 1) return;
    const sample = list[0];
    const [entityA, entityB] = sample.entities;
    const idA = entityA.getModel().id;
    const idB = entityB.getModel().id;
    const posA = entityPositions.get(idA);
    const posB = entityPositions.get(idB);
    if (!posA || !posB) return;
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const px = -ny;
    const py = nx;
    const baseX = targets.get(sample.relNode.getModel().id)?.x || (posA.x + posB.x) / 2;
    const baseY = targets.get(sample.relNode.getModel().id)?.y || (posA.y + posB.y) / 2;
    const maxRadius = Math.max(...list.map((item) => item.relRadius));
    const offsetStep = maxRadius * 2 + 16;
    const sorted = list.slice().sort((a, b) => a.relNode.getModel().id.localeCompare(b.relNode.getModel().id));
    const mid = (sorted.length - 1) / 2;
    sorted.forEach((item, idx) => {
      const offsetIndex = idx - mid;
      const ox = px * offsetIndex * offsetStep;
      const oy = py * offsetIndex * offsetStep;
      const newPos = { x: baseX + ox, y: baseY + oy };
      const rid = item.relNode.getModel().id;
      targets.set(rid, newPos);
      relAnchors.set(rid, newPos);
    });
  });
  if (relAnchors.size) {
    const relPositions = /* @__PURE__ */ new Map();
    relAnchors.forEach((anchor, id) => {
      const t = targets.get(id);
      relPositions.set(id, t ? { ...t } : { ...anchor });
    });
    const relIdArr = [];
    relPositions.forEach((_, id) => relIdArr.push(id));
    const maxRelR = relIdArr.length ? Math.max(...relIdArr.map((id) => relRadii.get(id) || 30)) : 30;
    const relCellSize = Math.max(60, maxRelR * 2 + 14);
    for (let iter = 0; iter < 80; iter++) {
      let moved = 0;
      const relItems = relIdArr.map((id) => ({
        id,
        pos: relPositions.get(id),
        r: relRadii.get(id) || 30
      }));
      const relGrid = buildGrid(relItems, relCellSize);
      for (let i = 0; i < relItems.length; i++) {
        const a = relItems[i];
        forEachNeighbor(relGrid, relCellSize, a, (b) => {
          if (b.id <= a.id) return;
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const minDist = a.r + b.r + 14;
          if (dist < minDist) {
            const push = (minDist - dist) / 2;
            const nx = dx / dist;
            const ny = dy / dist;
            a.pos.x -= nx * push;
            a.pos.y -= ny * push;
            b.pos.x += nx * push;
            b.pos.y += ny * push;
            if (push > moved) moved = push;
          }
        });
      }
      relPositions.forEach((pos, rid) => {
        const relNode = graph.findById(rid);
        const connected = relNode ? relationshipConnections.get(rid) : null;
        if (!connected) return;
        const relR = relRadii.get(rid) || 30;
        connected.forEach((entNode) => {
          const em = entNode.getModel();
          const center = entityPositions.get(em.id) || { x: em.x, y: em.y };
          const dx = pos.x - center.x;
          const dy = pos.y - center.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const limit = computeEntityRelMinCenterDistance(
            em.id,
            relNode,
            dx / dist,
            dy / dist
          );
          if (dist < limit) {
            const push = limit - dist;
            const nx = dx / dist;
            const ny = dy / dist;
            pos.x += nx * push;
            pos.y += ny * push;
            if (push > moved) moved = push;
          }
        });
      });
      relPositions.forEach((pos, id) => {
        const anchor = relAnchors.get(id);
        if (!anchor) return;
        pos.x = pos.x * 0.85 + anchor.x * 0.15;
        pos.y = pos.y * 0.85 + anchor.y * 0.15;
      });
      if (moved < 0.3) break;
    }
    relPositions.forEach((pos, id) => {
      targets.set(id, { ...pos });
    });
  }
  const applyGlobalSeparation = () => {
    const allNodes = graph.getNodes();
    const lockedCoreIds = /* @__PURE__ */ new Set([
      ...entityNodes.map((n) => n.getModel().id),
      ...relationshipNodes.map((n) => n.getModel().id)
    ]);
    const metaArr = allNodes.map((n) => ({
      id: n.getModel().id,
      r: getRadius2(n)
    }));
    metaArr.forEach((m) => {
      if (!targets.has(m.id)) {
        const model = graph.findById(m.id)?.getModel();
        targets.set(m.id, {
          x: typeof model?.x === "number" ? model.x : 0,
          y: typeof model?.y === "number" ? model.y : 0
        });
      }
    });
    const maxR = metaArr.length ? Math.max(...metaArr.map((m) => m.r)) : 30;
    const cellSize = Math.max(40, maxR * 2 + 8);
    for (let iter = 0; iter < 400; iter++) {
      let maxMove = 0;
      const items = metaArr.map((m) => ({
        id: m.id,
        r: m.r,
        pos: targets.get(m.id)
      }));
      const grid = buildGrid(items, cellSize);
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        forEachNeighbor(grid, cellSize, a, (b) => {
          if (b.id <= a.id) return;
          const dx = b.pos.x - a.pos.x;
          const dy = b.pos.y - a.pos.y;
          let dist = Math.hypot(dx, dy);
          if (dist === 0) dist = 0.01;
          const minDist = a.r + b.r + 8;
          if (dist < minDist) {
            const overlap = minDist - dist;
            const aLocked = lockedCoreIds.has(a.id);
            const bLocked = lockedCoreIds.has(b.id);
            if (aLocked && bLocked) return;
            const pushA = aLocked ? 0 : overlap / (bLocked ? 1 : 2);
            const pushB = bLocked ? 0 : overlap / (aLocked ? 1 : 2);
            const nx = dx / dist;
            const ny = dy / dist;
            a.pos.x -= nx * pushA;
            a.pos.y -= ny * pushA;
            b.pos.x += nx * pushB;
            b.pos.y += ny * pushB;
            const push = Math.max(pushA, pushB);
            if (push > maxMove) maxMove = push;
          }
        });
      }
      if (maxMove < 0.3) break;
    }
  };
  applyGlobalSeparation();
  animateNodesToTargets(graph, targets, 850, () => {
    smoothFitView(graph, 800, "easeOutCubic");
  });
};

// src/graph/updateGraphStyles.ts
var clampFontScale = (scale) => {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
};
var nodeFontSize = (model, scale) => {
  const base = model.nodeType === "entity" ? 18 : model.nodeType === "relationship" ? 16 : 15;
  return base * scale;
};
var updateGraphStyles = (graphInstance, colored, fontScale = 1) => {
  if (!graphInstance || graphInstance.destroyed) return;
  const safeFontScale = clampFontScale(fontScale);
  graphInstance.setAutoPaint(false);
  graphInstance.getNodes().forEach((node) => {
    const model = node.getModel();
    const styles = {};
    if (colored) {
      if (model.nodeType === "entity") {
        if (model.isPlaceholder) {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            lineDash: [4, 4],
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins",
              fontStyle: "italic"
            }
          };
        } else {
          styles.style = {
            fill: "#e0f2fe",
            stroke: "#0ea5e9",
            lineWidth: 2,
            shadowColor: "rgba(14, 165, 233, 0.2)",
            shadowBlur: 10
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins"
            }
          };
        }
      } else if (model.nodeType === "relationship") {
        styles.style = {
          fill: "#f5f3ff",
          stroke: "#8b5cf6",
          lineWidth: 2,
          shadowColor: "rgba(139, 92, 246, 0.2)",
          shadowBlur: 10
        };
        styles.labelCfg = {
          style: { fill: "#0f172a", fontFamily: "Poppins" }
        };
      } else if (model.nodeType === "attribute") {
        if (model.keyType === "pk") {
          styles.style = {
            fill: "#ecfdf5",
            stroke: "#10b981",
            lineWidth: 2,
            shadowColor: "rgba(16, 185, 129, 0.2)",
            shadowBlur: 5
          };
          styles.labelCfg = {
            style: {
              fill: "#0f172a",
              fontWeight: "700",
              fontFamily: "Poppins"
            }
          };
        } else {
          styles.style = {
            fill: "#ffffff",
            stroke: "#94a3b8",
            lineWidth: 2
          };
          styles.labelCfg = {
            style: {
              fill: "#475569",
              fontWeight: "normal",
              fontFamily: "Poppins"
            }
          };
        }
      }
    } else {
      styles.style = {
        fill: "#ffffff",
        stroke: "#1e293b",
        lineWidth: 2,
        shadowBlur: 0
      };
      if (model.isPlaceholder) {
        styles.style.lineDash = [4, 4];
        styles.style.stroke = "#64748b";
        styles.labelCfg = {
          style: {
            fill: "#64748b",
            fontWeight: "bold",
            fontStyle: "italic",
            fontFamily: "Poppins"
          }
        };
      } else {
        styles.labelCfg = {
          style: {
            fill: "#1e293b",
            fontWeight: model.nodeType === "entity" || model.keyType === "pk" ? "bold" : "normal",
            fontFamily: "Poppins"
          }
        };
      }
    }
    styles.labelCfg = {
      style: {
        ...styles.labelCfg?.style ?? {},
        fontSize: nodeFontSize(model, safeFontScale)
      }
    };
    graphInstance.updateItem(node, styles);
  });
  graphInstance.getEdges().forEach((edge) => {
    graphInstance.updateItem(edge, {
      style: {
        stroke: "#000000",
        lineWidth: 1.5,
        endArrow: false
      },
      labelCfg: {
        style: {
          fill: "#000000",
          fontSize: 12 * safeFontScale,
          background: {
            fill: "#ffffff",
            padding: [2, 4, 2, 4],
            radius: 2
          }
        }
      }
    });
  });
  graphInstance.paint();
  graphInstance.setAutoPaint(true);
};

// .claude/skills/sql2er/scripts/engine/adapter.ts
var makeBBox = (model) => {
  const { width, height } = measureNodeSize(model);
  const x = typeof model.x === "number" ? model.x : 0;
  const y = typeof model.y === "number" ? model.y : 0;
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    minX: x - halfW,
    minY: y - halfH,
    maxX: x + halfW,
    maxY: y + halfH,
    width,
    height,
    centerX: x,
    centerY: y
  };
};
function createHeadlessGraph(nodeModels, edgeModels, width = 1200, height = 800) {
  const nodeObjs = nodeModels.map((model) => ({
    getModel: () => model,
    getID: () => model.id,
    getBBox: () => makeBBox(model),
    getContainer: () => ({}),
    destroyed: false
  }));
  const edgeObjs = edgeModels.map((model) => ({
    getModel: () => model,
    destroyed: false
  }));
  const byId = new Map(nodeObjs.map((n) => [n.getModel().id, n]));
  const edgeById = /* @__PURE__ */ new Map();
  edgeObjs.forEach((e) => {
    const id = e.getModel().id;
    if (id) edgeById.set(id, e);
  });
  const group = {
    getMatrix: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    setMatrix: () => {
    }
  };
  let w = width;
  let h = height;
  const graph = {
    nodeModels,
    edgeModels,
    destroyed: false,
    getNodes: () => nodeObjs,
    getEdges: () => edgeObjs,
    findById: (id) => byId.get(id) ?? edgeById.get(id) ?? null,
    updateItem: (item, model) => {
      const target = item;
      const m = typeof target?.getModel === "function" ? target.getModel() : item;
      if (m && model) Object.assign(m, model);
    },
    setAutoPaint: () => {
    },
    paint: () => {
    },
    refresh: () => {
    },
    refreshPositions: () => {
    },
    get: (key) => key === "width" ? w : key === "height" ? h : key === "group" ? group : void 0,
    getZoom: () => 1,
    zoomTo: () => {
    },
    fitView: () => {
    },
    clear: () => {
    },
    destroy: () => {
    },
    changeSize: (nextW, nextH) => {
      w = nextW;
      h = nextH;
    }
  };
  return graph;
}

// .claude/skills/sql2er/scripts/engine/ops.ts
var CANVAS_W = 1200;
var CANVAS_H = 800;
var DEFAULT_SETTINGS = {
  colored: true,
  comment: false,
  hideAttrs: false,
  fontScale: 1
};
function clampFontScale2(scale) {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
}
function deltaToScale(delta) {
  return clampFontScale2(1 + (Number.isFinite(delta) ? delta : 0) * 0.1);
}
function parseInput(text, format) {
  const trimmed = String(text || "").trim();
  if (format === "sql") return { result: parseSQLTables(trimmed), format: "sql" };
  if (format === "dbml") return { result: parseDBML(trimmed), format: "dbml" };
  const sql = parseSQLTables(trimmed);
  if (sql.tables.length > 0) return { result: sql, format: "sql" };
  return { result: parseDBML(trimmed), format: "dbml" };
}
function styleAndSize(nodes, edges, settings) {
  const graph = createHeadlessGraph(nodes, edges, CANVAS_W, CANVAS_H);
  updateGraphStyles(graph, settings.colored, clampFontScale2(settings.fontScale));
  return graph;
}
function generate(opts) {
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings ?? {} };
  settings.fontScale = clampFontScale2(settings.fontScale);
  const { result, format } = parseInput(opts.input, opts.format ?? "auto");
  if (!result.tables.length) {
    throw new Error("No tables parsed from input (tried " + (opts.format ?? "auto") + ").");
  }
  const { nodes, edges } = generateChenModelData(
    result.tables,
    result.relationships,
    settings.colored,
    settings.comment ? "comment" : "name",
    settings.hideAttrs
  );
  const graph = styleAndSize(nodes, edges, settings);
  const layout = opts.layout ?? "align";
  if (layout !== "none") {
    forceAlignLayout(graph, CANVAS_W);
    if (layout === "arrange") arrangeLayout(graph);
  }
  return { version: 1, input: opts.input, format, settings, nodes, edges };
}
function runLayout(state, kind) {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  if (kind === "align") forceAlignLayout(graph, CANVAS_W);
  else arrangeLayout(graph);
  return { ...state };
}
function setFontScale(state, delta) {
  const fontScale = deltaToScale(delta);
  const settings = { ...state.settings, fontScale };
  styleAndSize(state.nodes, state.edges, settings);
  return { ...state, settings };
}
function centroid(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodes.forEach((n) => {
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
function rotate(state, degrees) {
  const theta = (Number(degrees) || 0) * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const { cx, cy } = centroid(state.nodes);
  state.nodes.forEach((n) => {
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    const dx = x - cx;
    const dy = y - cy;
    n.x = cx + dx * cos - dy * sin;
    n.y = cy + dx * sin + dy * cos;
  });
  return { ...state };
}
function resolveNode(state, arg) {
  const byId = state.nodes.find((n) => n.id === arg);
  if (byId) return byId;
  const low = arg.toLowerCase();
  const ents = state.nodes.filter(
    (n) => n.nodeType === "entity" && String(n.label).toLowerCase() === low
  );
  if (ents.length === 1) return ents[0];
  const byName = state.nodes.filter(
    (n) => n.nodeType === "entity" && String(n.nameLabel ?? "").toLowerCase() === low
  );
  if (byName.length === 1) return byName[0];
  return null;
}
function translateCluster(state, node, dx, dy) {
  node.x = (typeof node.x === "number" ? node.x : 0) + dx;
  node.y = (typeof node.y === "number" ? node.y : 0) + dy;
  if (node.nodeType === "entity") {
    state.nodes.forEach((n) => {
      if (n.nodeType === "attribute" && n.parentEntity === node.id) {
        n.x = (typeof n.x === "number" ? n.x : 0) + dx;
        n.y = (typeof n.y === "number" ? n.y : 0) + dy;
      }
    });
  }
}
function settle(state) {
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  arrangeLayout(graph);
}
function move(state, arg, x, y, raw) {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  const dx = x - (typeof node.x === "number" ? node.x : 0);
  const dy = y - (typeof node.y === "number" ? node.y : 0);
  translateCluster(state, node, dx, dy);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}
function nudge(state, arg, dx, dy, raw) {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  translateCluster(state, node, dx, dy);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}
function swap(state, argA, argB, raw) {
  const a = resolveNode(state, argA);
  const b = resolveNode(state, argB);
  if (!a) throw new Error(unresolved(state, argA));
  if (!b) throw new Error(unresolved(state, argB));
  const ax = typeof a.x === "number" ? a.x : 0;
  const ay = typeof a.y === "number" ? a.y : 0;
  const bx = typeof b.x === "number" ? b.x : 0;
  const by = typeof b.y === "number" ? b.y : 0;
  translateCluster(state, a, bx - ax, by - ay);
  translateCluster(state, b, ax - bx, ay - by);
  if (!raw) settle(state);
  return {
    state: { ...state },
    resolved: [
      { id: a.id, label: String(a.label) },
      { id: b.id, label: String(b.label) }
    ]
  };
}
function unresolved(state, arg) {
  const ents = state.nodes.filter((n) => n.nodeType === "entity").map((n) => String(n.label));
  return `Could not resolve "${arg}" to a unique node. Entities: ${ents.join(", ")}. Use an exact node id from describe.`;
}

// .claude/skills/sql2er/scripts/engine/describe.ts
var num = (v, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var short = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
var segCross = (a1, a2, b1, b2) => {
  const eq = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
  const c = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = c(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = c(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = c(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = c(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
};
function buildScene(graph) {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();
  const entities = [];
  const placeholders = /* @__PURE__ */ new Set();
  const attrsByEntity = /* @__PURE__ */ new Map();
  const relNodes = [];
  nodes.forEach((n) => {
    const m = n.getModel();
    const b = n.getBBox();
    if (m.nodeType === "entity") {
      entities.push({
        id: m.id,
        type: "entity",
        label: String(m.label ?? m.id),
        x: num(m.x),
        y: num(m.y),
        w: b.width,
        h: b.height
      });
      if (m.isPlaceholder) placeholders.add(m.id);
    } else if (m.nodeType === "relationship") {
      relNodes.push(m);
    } else if (m.nodeType === "attribute") {
      const pid = String(m.parentEntity ?? "");
      if (!attrsByEntity.has(pid)) attrsByEntity.set(pid, []);
      attrsByEntity.get(pid).push(m);
    }
  });
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const bboxOf = new Map(nodes.map((n) => [n.getModel().id, n.getBBox()]));
  const relationships = relNodes.map((m) => {
    const rid = m.id;
    let fromId = null;
    let toId = null;
    let cardFrom = "N";
    let cardTo = "1";
    edges.forEach((e) => {
      const em = e.getModel();
      if (em.edgeType === "entity-relationship" && em.target === rid) {
        fromId = em.source;
        if (em.label != null) cardFrom = String(em.label);
      } else if (em.edgeType === "relationship-entity" && em.source === rid) {
        toId = em.target;
        if (em.label != null) cardTo = String(em.label);
      }
    });
    const b = bboxOf.get(rid);
    return {
      id: rid,
      label: String(m.label ?? rid),
      x: num(m.x),
      y: num(m.y),
      fromId,
      toId,
      cardFrom,
      cardTo,
      selfLoop: !!m.isSelfLoop || fromId !== null && fromId === toId
    };
  });
  const adj = /* @__PURE__ */ new Map();
  entities.forEach((e) => adj.set(e.id, /* @__PURE__ */ new Set()));
  relationships.forEach((r) => {
    if (r.fromId && r.toId && r.fromId !== r.toId && adj.has(r.fromId) && adj.has(r.toId)) {
      adj.get(r.fromId).add(r.toId);
      adj.get(r.toId).add(r.fromId);
    }
  });
  const seen = /* @__PURE__ */ new Set();
  const components = [];
  [...entities].sort((a, b) => a.id.localeCompare(b.id)).forEach((e) => {
    if (seen.has(e.id)) return;
    const stack = [e.id];
    const comp = [];
    seen.add(e.id);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      (adj.get(cur) ?? []).forEach((nb) => {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      });
    }
    components.push(comp.sort());
  });
  const isolated = entities.filter((e) => (adj.get(e.id)?.size ?? 0) === 0).map((e) => e.id);
  const segs = relationships.filter((r) => r.fromId && r.toId && !r.selfLoop).map((r) => ({ r, a: entityById.get(r.fromId), b: entityById.get(r.toId) })).filter((s) => s.a && s.b);
  const crossings = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const si = segs[i];
      const sj = segs[j];
      const shared = si.a.id === sj.a.id || si.a.id === sj.b.id || si.b.id === sj.a.id || si.b.id === sj.b.id;
      if (shared) continue;
      if (segCross(si.a, si.b, sj.a, sj.b)) crossings.push([si.r, sj.r]);
    }
  }
  const core = [
    ...entities,
    ...relationships.map(
      (r) => entityById.get(r.id) ?? {
        id: r.id,
        type: "relationship",
        label: r.label,
        x: r.x,
        y: r.y,
        w: bboxOf.get(r.id)?.width ?? 60,
        h: bboxOf.get(r.id)?.height ?? 40
      }
    )
  ];
  const coreInfos = entities.concat(
    relationships.map((r) => {
      const b = bboxOf.get(r.id);
      return {
        id: r.id,
        type: "relationship",
        label: r.label,
        x: r.x,
        y: r.y,
        w: b.width,
        h: b.height
      };
    })
  );
  const overlaps = [];
  for (let i = 0; i < coreInfos.length; i++) {
    for (let j = i + 1; j < coreInfos.length; j++) {
      const a = coreInfos[i];
      const b = coreInfos[j];
      const gap = 2;
      if (Math.abs(a.x - b.x) < a.w / 2 + b.w / 2 - gap && Math.abs(a.y - b.y) < a.h / 2 + b.h / 2 - gap) {
        overlaps.push([a, b]);
      }
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  coreInfos.forEach((c) => {
    minX = Math.min(minX, c.x - c.w / 2);
    minY = Math.min(minY, c.y - c.h / 2);
    maxX = Math.max(maxX, c.x + c.w / 2);
    maxY = Math.max(maxY, c.y + c.h / 2);
  });
  if (!coreInfos.length) {
    minX = minY = 0;
    maxX = maxY = 0;
  }
  void core;
  return {
    entities,
    relationships,
    core: coreInfos,
    attrsByEntity,
    entityById,
    components,
    isolated,
    placeholders,
    crossings,
    overlaps,
    bbox: { minX, minY, maxX, maxY }
  };
}
function asciiMap(scene) {
  const nodes = scene.core;
  if (nodes.length === 0) return ["(empty)"];
  const { minX, minY, maxX, maxY } = scene.bbox;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const cols = Math.max(4, Math.min(12, Math.round(Math.sqrt(nodes.length) * 2.2)));
  const rows = Math.max(3, Math.min(14, Math.round(cols * (spanY / spanX)) || 3));
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const cell = (c) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.round((c.x - minX) / spanX * (cols - 1))));
    const cy = Math.min(rows - 1, Math.max(0, Math.round((c.y - minY) / spanY * (rows - 1))));
    return [cy, cx];
  };
  const place = (r, c, token) => {
    for (let radius = 0; radius < Math.max(rows, cols); radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          if (grid[rr][cc] === null) {
            grid[rr][cc] = token;
            return;
          }
        }
      }
    }
  };
  scene.entities.forEach((e) => {
    const [r, c] = cell(e);
    place(r, c, short(e.label, 8));
  });
  scene.relationships.forEach((r) => {
    const info = scene.core.find((c) => c.id === r.id);
    if (!info) return;
    const [rr, cc] = cell(info);
    place(rr, cc, "\u25C7" + short(r.label, 5));
  });
  const cw = 10;
  return grid.map(
    (row) => row.map((t) => (t ?? "").padEnd(cw)).join("").replace(/\s+$/, "")
  );
}
function describe(graph, opts = {}) {
  const scene = buildScene(graph);
  const L = [];
  if (opts.focus) {
    return describeFocus(scene, opts.focus).join("\n");
  }
  L.push(
    `COMPONENTS: ${scene.components.length}` + (scene.isolated.length ? `  (isolated: ${scene.isolated.length})` : "")
  );
  scene.components.forEach((comp, i) => {
    const labels = comp.map((id) => scene.entityById.get(id)?.label ?? id);
    L.push(`  C${i + 1} {${labels.join(", ")}}`);
  });
  L.push("");
  L.push("ENTITIES  (id | label | pos | size | deg | attrs)");
  scene.entities.forEach((e) => {
    const attrs = scene.attrsByEntity.get(e.id) ?? [];
    const pk = attrs.filter((a) => a.keyType === "pk").length;
    const deg = scene.relationships.filter((r) => r.fromId === e.id || r.toId === e.id).length;
    const tag = scene.placeholders.has(e.id) ? " [placeholder]" : "";
    L.push(
      `  ${e.id}  ${e.label}${tag}  (${Math.round(e.x)},${Math.round(e.y)})  ${Math.round(e.w)}\xD7${Math.round(e.h)}  deg=${deg}  attrs=${attrs.length}${pk ? `(${pk}pk)` : ""}`
    );
  });
  L.push("");
  if (scene.relationships.length) {
    L.push("RELATIONS  (id | label | from\u2192to | card | pos)");
    scene.relationships.forEach((r) => {
      const from = r.fromId ? scene.entityById.get(r.fromId)?.label ?? r.fromId : "?";
      const to = r.toId ? scene.entityById.get(r.toId)?.label ?? r.toId : "?";
      const self = r.selfLoop ? " [self]" : "";
      L.push(
        `  ${r.id}  ${r.label}  ${from}\u2192${to}${self}  ${r.cardFrom}:${r.cardTo}  (${Math.round(r.x)},${Math.round(r.y)})`
      );
    });
    L.push("");
  }
  L.push("DIAGNOSTICS");
  if (scene.crossings.length) {
    scene.crossings.slice(0, 12).forEach(([a, b]) => L.push(`  \u26A0 crossing: ${a.label} \xD7 ${b.label}`));
    if (scene.crossings.length > 12) L.push(`  \u2026 +${scene.crossings.length - 12} more crossings`);
  } else {
    L.push("  \u2713 no edge crossings");
  }
  if (scene.overlaps.length) {
    scene.overlaps.slice(0, 12).forEach(([a, b]) => L.push(`  \u26A0 overlap: ${a.label} \xD7 ${b.label}`));
    if (scene.overlaps.length > 12) L.push(`  \u2026 +${scene.overlaps.length - 12} more overlaps`);
  } else {
    L.push("  \u2713 no node overlaps");
  }
  scene.isolated.forEach((id) => L.push(`  \u26A0 isolated: ${scene.entityById.get(id)?.label ?? id}`));
  const w = Math.round(scene.bbox.maxX - scene.bbox.minX);
  const h = Math.round(scene.bbox.maxY - scene.bbox.minY);
  const aspect = h > 0 ? (w / h).toFixed(2) : "\u2014";
  let edgeLen = 0;
  scene.relationships.forEach((r) => {
    if (r.fromId && r.toId) {
      const a = scene.entityById.get(r.fromId);
      const b = scene.entityById.get(r.toId);
      if (a && b) edgeLen += Math.hypot(b.x - a.x, b.y - a.y);
    }
  });
  L.push(
    `  metrics: crossings=${scene.crossings.length} overlaps=${scene.overlaps.length} bbox=${w}\xD7${h} aspect=${aspect} edgeLen=${Math.round(edgeLen)}`
  );
  L.push("");
  L.push("MAP  (coarse 2D placement; authoritative coords above)");
  asciiMap(scene).forEach((row) => L.push("  " + row));
  if (opts.full) {
    L.push("");
    L.push("ATTRIBUTES  (id | label | parent | pos)");
    scene.entities.forEach((e) => {
      (scene.attrsByEntity.get(e.id) ?? []).forEach((a) => {
        L.push(
          `  ${a.id}  ${a.label}${a.keyType === "pk" ? " [pk]" : ""}  ${e.label}  (${Math.round(num(a.x))},${Math.round(num(a.y))})`
        );
      });
    });
  }
  return L.join("\n");
}
function describeFocus(scene, focusArg) {
  const ent = scene.entityById.get(focusArg) ?? scene.entities.find((e) => e.label.toLowerCase() === focusArg.toLowerCase());
  if (!ent) return [`focus: no entity matching "${focusArg}"`];
  const L = [];
  L.push(
    `FOCUS ${ent.id}  ${ent.label}  (${Math.round(ent.x)},${Math.round(ent.y)})  ${Math.round(ent.w)}\xD7${Math.round(ent.h)}`
  );
  const rels = scene.relationships.filter((r) => r.fromId === ent.id || r.toId === ent.id);
  L.push(`  relations: ${rels.length}`);
  rels.forEach((r) => {
    const otherId = r.fromId === ent.id ? r.toId : r.fromId;
    const other = otherId ? scene.entityById.get(otherId)?.label ?? otherId : "self";
    L.push(
      `    ${r.id}  ${r.label} \u2192 ${other}  ${r.cardFrom}:${r.cardTo}  (${Math.round(r.x)},${Math.round(r.y)})`
    );
  });
  const attrs = scene.attrsByEntity.get(ent.id) ?? [];
  L.push(`  attributes: ${attrs.length}`);
  attrs.forEach((a) => {
    L.push(
      `    ${a.id}  ${a.label}${a.keyType === "pk" ? " [pk]" : ""}  (${Math.round(num(a.x))},${Math.round(num(a.y))})`
    );
  });
  return L;
}
function describeJson(graph) {
  const s = buildScene(graph);
  return {
    entities: s.entities.map((e) => ({
      id: e.id,
      label: e.label,
      x: Math.round(e.x),
      y: Math.round(e.y),
      w: Math.round(e.w),
      h: Math.round(e.h),
      placeholder: s.placeholders.has(e.id)
    })),
    relationships: s.relationships.map((r) => ({
      id: r.id,
      label: r.label,
      from: r.fromId,
      to: r.toId,
      card: `${r.cardFrom}:${r.cardTo}`,
      x: Math.round(r.x),
      y: Math.round(r.y)
    })),
    diagnostics: {
      crossings: s.crossings.length,
      overlaps: s.overlaps.length,
      isolated: s.isolated.map((id) => s.entityById.get(id)?.label ?? id),
      bbox: { w: Math.round(s.bbox.maxX - s.bbox.minX), h: Math.round(s.bbox.maxY - s.bbox.minY) }
    }
  };
}

// src/exporter.ts
function escapeXml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function buildVertexStyle(model) {
  const s = model.style || {};
  const fill = s.fill || "#ffffff";
  const stroke = s.stroke || "#000000";
  const strokeWidth = s.lineWidth || 1;
  const dashed = Array.isArray(s.lineDash) && s.lineDash.length ? "dashed=1;" : "";
  const labelFontColor = model.labelCfg && model.labelCfg.style && model.labelCfg.style.fill || "#1e293b";
  const lblStyle = model.labelCfg && model.labelCfg.style || {};
  let fontStyle = 0;
  if (lblStyle.fontWeight === "bold" || lblStyle.fontWeight === "700" || lblStyle.fontWeight === 700)
    fontStyle |= 1;
  if (lblStyle.fontStyle === "italic") fontStyle |= 2;
  if (model.nodeType === "entity") {
    return `rounded=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=16;fontStyle=${fontStyle || 1};fontColor=${labelFontColor};${dashed}`;
  }
  if (model.nodeType === "attribute") {
    if (model.keyType === "pk") fontStyle |= 4 | 1;
    return `ellipse;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=13;fontStyle=${fontStyle};fontColor=${labelFontColor};${dashed}`;
  }
  if (model.nodeType === "relationship") {
    return `rhombus;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=14;fontStyle=${fontStyle};fontColor=${labelFontColor};${dashed}`;
  }
  return `rounded=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};strokeWidth=${strokeWidth};`;
}
function buildEdgeStyle(model) {
  const s = model.style || {};
  const stroke = s.stroke || "#000000";
  const strokeWidth = s.lineWidth || 1;
  return `endArrow=none;html=1;rounded=0;edgeStyle=none;strokeColor=${stroke};strokeWidth=${strokeWidth};fontSize=12;`;
}
function makeDiagramId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `sql2er-${t}-${r}`;
}
function buildDrawioXML(graph) {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();
  const cells = [];
  cells.push('<mxCell id="0" />');
  cells.push('<mxCell id="1" parent="0" />');
  const idMap = /* @__PURE__ */ new Map();
  let vi = 0;
  nodes.forEach((node) => {
    const model = node.getModel();
    const bbox = node.getBBox();
    const id = `v${vi++}`;
    idMap.set(model.id, id);
    const style = buildVertexStyle(model);
    const label = escapeXml(model.label || "");
    const x = Math.round(bbox.minX);
    const y = Math.round(bbox.minY);
    const w = Math.round(bbox.width);
    const h = Math.round(bbox.height);
    cells.push(
      `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" /></mxCell>`
    );
  });
  let ei = 0;
  edges.forEach((edge) => {
    const model = edge.getModel();
    const source = idMap.get(model.source);
    const target = idMap.get(model.target);
    if (!source || !target) return;
    const id = `e${ei++}`;
    const style = buildEdgeStyle(model);
    const label = escapeXml(model.label || "");
    cells.push(
      `<mxCell id="${id}" value="${label}" style="${style}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    );
  });
  const diagramId = makeDiagramId();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" agent="sql2er" version="24.0.0" type="device"><diagram id="${diagramId}" name="ER"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>`;
  return xml;
}

// .claude/skills/sql2er/scripts/engine/exporters.ts
var esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function exportDrawio(state) {
  const graph = createHeadlessGraph(state.nodes, state.edges);
  return buildDrawioXML(graph);
}
function exportJson(state) {
  const sized = new Map(state.nodes.map((n) => [n.id, measureNodeSize(n)]));
  const out = {
    nodes: state.nodes.map((n) => {
      const s = sized.get(n.id);
      return {
        id: n.id,
        type: n.nodeType,
        label: n.label,
        x: Math.round(typeof n.x === "number" ? n.x : 0),
        y: Math.round(typeof n.y === "number" ? n.y : 0),
        w: Math.round(s.width),
        h: Math.round(s.height),
        ...n.keyType === "pk" ? { pk: true } : {},
        ...n.parentEntity ? { parent: n.parentEntity } : {},
        ...n.isPlaceholder ? { placeholder: true } : {}
      };
    }),
    edges: state.edges.map((e) => ({
      source: e.source,
      target: e.target,
      label: e.label ?? "",
      type: e.edgeType ?? ""
    }))
  };
  return JSON.stringify(out, null, 2);
}
function exportSvg(state) {
  const sized = /* @__PURE__ */ new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.nodes.forEach((n) => {
    const { width, height } = measureNodeSize(n);
    const cx = typeof n.x === "number" ? n.x : 0;
    const cy = typeof n.y === "number" ? n.y : 0;
    sized.set(n.id, { cx, cy, w: width, h: height, m: n });
    minX = Math.min(minX, cx - width / 2);
    minY = Math.min(minY, cy - height / 2);
    maxX = Math.max(maxX, cx + width / 2);
    maxY = Math.max(maxY, cy + height / 2);
  });
  if (!state.nodes.length) {
    minX = minY = 0;
    maxX = maxY = 100;
  }
  const pad = 40;
  const vbX = minX - pad;
  const vbY = minY - pad;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(vbW)}" height="${Math.round(vbH)}" viewBox="${Math.round(vbX)} ${Math.round(vbY)} ${Math.round(vbW)} ${Math.round(vbH)}" font-family="sans-serif">`
  );
  parts.push(
    `<rect x="${Math.round(vbX)}" y="${Math.round(vbY)}" width="${Math.round(vbW)}" height="${Math.round(vbH)}" fill="#ffffff"/>`
  );
  state.edges.forEach((e) => {
    const s = sized.get(e.source);
    const t = sized.get(e.target);
    if (!s || !t) return;
    parts.push(
      `<line x1="${s.cx.toFixed(1)}" y1="${s.cy.toFixed(1)}" x2="${t.cx.toFixed(1)}" y2="${t.cy.toFixed(1)}" stroke="#000" stroke-width="1.5"/>`
    );
  });
  state.nodes.forEach((n) => {
    const s = sized.get(n.id);
    const fill = n.style?.fill ?? "#fff";
    const stroke = n.style?.stroke ?? "#000";
    const lw = n.style?.lineWidth ?? 1.5;
    const dash = Array.isArray(n.style?.lineDash) && n.style?.lineDash.length ? ` stroke-dasharray="4 4"` : "";
    const fontFill = n.labelCfg?.style?.fill ?? "#000";
    const fontSize = n.labelCfg?.style?.fontSize ?? (n.nodeType === "entity" ? 18 : n.nodeType === "relationship" ? 16 : 15);
    const bold = n.labelCfg?.style?.fontWeight === "bold" || n.labelCfg?.style?.fontWeight === "700" || n.labelCfg?.style?.fontWeight === 700;
    const fw = bold ? ` font-weight="bold"` : "";
    const { cx, cy, w, h } = s;
    if (n.nodeType === "entity") {
      parts.push(
        `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`
      );
    } else if (n.nodeType === "relationship") {
      const pts = `${cx},${(cy - h / 2).toFixed(1)} ${(cx + w / 2).toFixed(1)},${cy} ${cx},${(cy + h / 2).toFixed(1)} ${(cx - w / 2).toFixed(1)},${cy}`;
      parts.push(
        `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`
      );
    } else {
      parts.push(
        `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${lw}"${dash}/>`
      );
    }
    const label = esc(n.label ?? "");
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${(cy + Number(fontSize) * 0.34).toFixed(1)}" font-size="${fontSize}" fill="${fontFill}"${fw} text-anchor="middle">${label}</text>`
    );
    if (n.nodeType === "attribute" && n.keyType === "pk") {
      const tw = String(n.label ?? "").length * Number(fontSize) * 0.55;
      const uy = cy + Number(fontSize) * 0.62;
      parts.push(
        `<line x1="${(cx - tw / 2).toFixed(1)}" y1="${uy.toFixed(1)}" x2="${(cx + tw / 2).toFixed(1)}" y2="${uy.toFixed(1)}" stroke="${fontFill}" stroke-width="1"/>`
      );
    }
  });
  state.edges.forEach((e) => {
    if (e.label == null || e.label === "") return;
    const s = sized.get(e.source);
    const t = sized.get(e.target);
    if (!s || !t) return;
    const mx = (s.cx + t.cx) / 2;
    const my = (s.cy + t.cy) / 2;
    parts.push(
      `<rect x="${(mx - 7).toFixed(1)}" y="${(my - 8).toFixed(1)}" width="14" height="14" fill="#fff"/>`
    );
    parts.push(
      `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" font-size="12" fill="#000" text-anchor="middle">${esc(e.label)}</text>`
    );
  });
  parts.push("</svg>");
  return parts.join("\n");
}

// .claude/skills/sql2er/scripts/engine/cli.ts
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}
var boolFlag = (v, def = false) => {
  if (v === void 0) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === "yes";
};
function statePath(flags) {
  const p = typeof flags.state === "string" ? flags.state : "sql2er-state.json";
  return resolve(process.cwd(), p);
}
function loadState(flags) {
  const p = statePath(flags);
  if (!existsSync(p)) throw new Error(`No state at ${p}. Run \`generate\` first.`);
  return JSON.parse(readFileSync(p, "utf8"));
}
function saveState(flags, state) {
  writeFileSync(statePath(flags), JSON.stringify(state), "utf8");
}
function readInput(flags) {
  if (typeof flags.input === "string") return rf(resolve(process.cwd(), flags.input), "utf8");
  if (typeof flags.text === "string") return flags.text;
  if (flags.stdin || !process.stdin.isTTY) {
    try {
      return rf(0, "utf8");
    } catch {
    }
  }
  throw new Error("Provide input via --input <file>, --text <inline>, or piped stdin.");
}
function printState(state, flags) {
  const graph = createHeadlessGraph(state.nodes, state.edges);
  process.stdout.write(
    describe(graph, {
      full: boolFlag(flags.full),
      focus: typeof flags.focus === "string" ? flags.focus : void 0
    }) + "\n"
  );
}
var HELP = `sql2er-agent \u2014 headless SQL/DBML \u2192 Chen-model ER layout for agents

Usage: node sql2er-agent.mjs <command> [args] [--flags]   (state in ./sql2er-state.json)

  generate                 Parse input, build the ER graph, lay it out.
      --input <file> | --text "<sql>" | (piped stdin)
      --format auto|sql|dbml         (default auto)
      --colored true|false           (default true)
      --comment                      show column/table comments instead of names
      --hide-attrs                   skeleton only (no attribute ellipses)
      --layout align|arrange|none    (default align)
  describe                 Print skeleton + diagnostics + ASCII map.
      --full                         also list attributes
      --focus <id|label>             zoom into one entity
      --json                         machine-readable scene
  layout <align|arrange>   Re-run a layout pass. align = topological from scratch;
                           arrange = settle current positions (use after edits).
  move <id|label> <x> <y>  Place an entity (its attributes follow). Then settles
                           with one arrange pass unless --raw.
  nudge <id|label> <dx> <dy>   Shift by a delta. --raw to skip the settle pass.
  swap <a> <b>             Exchange two entities' positions. --raw to skip settle.
  rotate <degrees>         Rotate the whole diagram about its centre (shapes stay upright).
  fontsize <delta>         0 = default; negative = smaller, positive = larger (\u2248\xB10.1/step).
  export <drawio|svg|json> Write output. --out <file> (else stdout).
  help
`;
function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  switch (cmd) {
    case "generate": {
      const input = readInput(flags);
      const state = generate({
        input,
        format: typeof flags.format === "string" ? flags.format : "auto",
        layout: typeof flags.layout === "string" ? flags.layout : "align",
        settings: {
          ...DEFAULT_SETTINGS,
          colored: boolFlag(flags.colored, true),
          comment: boolFlag(flags.comment),
          hideAttrs: boolFlag(flags["hide-attrs"])
        }
      });
      saveState(flags, state);
      printState(state, flags);
      break;
    }
    case "describe": {
      const state = loadState(flags);
      const graph = createHeadlessGraph(state.nodes, state.edges);
      if (boolFlag(flags.json)) {
        process.stdout.write(JSON.stringify(describeJson(graph), null, 2) + "\n");
      } else {
        printState(state, flags);
      }
      break;
    }
    case "layout": {
      const kind = _[1];
      if (kind !== "align" && kind !== "arrange") throw new Error("layout <align|arrange>");
      const next = runLayout(loadState(flags), kind);
      saveState(flags, next);
      printState(next, flags);
      break;
    }
    case "move": {
      const id = _[1];
      const x = Number(_[2]);
      const y = Number(_[3]);
      if (!id || !Number.isFinite(x) || !Number.isFinite(y))
        throw new Error("move <id|label> <x> <y>");
      const { state, resolved } = move(loadState(flags), id, x, y, boolFlag(flags.raw));
      saveState(flags, state);
      process.stdout.write(`moved ${resolved.map((r) => r.label).join(", ")}
`);
      printState(state, flags);
      break;
    }
    case "nudge": {
      const id = _[1];
      const dx = Number(_[2]);
      const dy = Number(_[3]);
      if (!id || !Number.isFinite(dx) || !Number.isFinite(dy))
        throw new Error("nudge <id|label> <dx> <dy>");
      const { state, resolved } = nudge(loadState(flags), id, dx, dy, boolFlag(flags.raw));
      saveState(flags, state);
      process.stdout.write(`nudged ${resolved.map((r) => r.label).join(", ")}
`);
      printState(state, flags);
      break;
    }
    case "swap": {
      const a = _[1];
      const b = _[2];
      if (!a || !b) throw new Error("swap <a> <b>");
      const { state, resolved } = swap(loadState(flags), a, b, boolFlag(flags.raw));
      saveState(flags, state);
      process.stdout.write(`swapped ${resolved.map((r) => r.label).join(" \u2194 ")}
`);
      printState(state, flags);
      break;
    }
    case "rotate": {
      const deg = Number(_[1]);
      if (!Number.isFinite(deg)) throw new Error("rotate <degrees>");
      const next = rotate(loadState(flags), deg);
      saveState(flags, next);
      printState(next, flags);
      break;
    }
    case "fontsize": {
      const delta = Number(_[1]);
      if (!Number.isFinite(delta)) throw new Error("fontsize <delta>  (0=default)");
      const next = setFontScale(loadState(flags), delta);
      saveState(flags, next);
      process.stdout.write(`fontScale=${next.settings.fontScale.toFixed(2)}
`);
      printState(next, flags);
      break;
    }
    case "export": {
      const fmt = _[1];
      const state = loadState(flags);
      let out;
      let ext;
      if (fmt === "drawio") {
        out = exportDrawio(state);
        ext = "drawio";
      } else if (fmt === "svg") {
        out = exportSvg(state);
        ext = "svg";
      } else if (fmt === "json") {
        out = exportJson(state);
        ext = "json";
      } else {
        throw new Error("export <drawio|svg|json>");
      }
      if (typeof flags.out === "string") {
        writeFileSync(resolve(process.cwd(), flags.out), out, "utf8");
        process.stdout.write(`wrote ${flags.out} (${ext}, ${out.length} bytes)
`);
      } else {
        process.stdout.write(out + "\n");
      }
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run \`help\`.`);
  }
}
try {
  main();
} catch (err) {
  process.stderr.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
}
