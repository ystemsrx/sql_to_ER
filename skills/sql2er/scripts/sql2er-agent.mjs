// skills/sql2er/scripts/engine/shims.ts
var g = globalThis;
var clock = 1e9;
g.requestAnimationFrame = (cb) => {
  clock += 1e9;
  cb(clock);
  return 0;
};
g.cancelAnimationFrame = () => {
};

// skills/sql2er/scripts/engine/cli.ts
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
    const GAP2 = 48;
    const chainSpacing = Math.max(200, maxR * 2 + GAP2);
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
    const unitWidth = maxR * 1.6 + GAP2;
    const approxWidth = (n) => Math.max(1, countLeaves(n)) * unitWidth;
    const placeNode = (node, parentPos, parentR, angle, sectorSize, minDist) => {
      const myR = radii.get(node.id);
      const defaultDist = parentR + myR + GAP2;
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
        targets.set(id, { x: p.x, y: p.y + r + myR + GAP2 });
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
  const rectBoundary2 = (rx, ry, cosT, sinT) => {
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
  const diamondBoundary2 = (rx, ry, cosT, sinT) => {
    if (rx <= 0 || ry <= 0) return 0;
    const denom = Math.abs(cosT) / rx + Math.abs(sinT) / ry;
    return denom > 1e-9 ? 1 / denom : 0;
  };
  const normalizeAngle3 = (a) => {
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
    const eOut = rectBoundary2(ehx, ehy, cosT, sinT);
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
    return rectBoundary2(ehx, ehy, ux, uy) + diamondBoundary2(rh.x, rh.y, ux, uy) + minEntityRelationGap;
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
    const aEntity = rectBoundary2(entityHalfX.get(idA) ?? 30, entityHalfY.get(idA) ?? 30, ux, uy);
    const bEntity = rectBoundary2(entityHalfX.get(idB) ?? 30, entityHalfY.get(idB) ?? 30, -ux, -uy);
    const rh = getRelHalfSize(relNode);
    const relToA = diamondBoundary2(rh.x, rh.y, -ux, -uy);
    const relToB = diamondBoundary2(rh.x, rh.y, ux, uy);
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
  const countCrossings2 = () => {
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
    let currentCrossings = countCrossings2();
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
            const newCrossings = countCrossings2();
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
          const angle = normalizeAngle3(Math.atan2(otherPos.y - center.y, otherPos.x - center.x));
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
      const angleA = normalizeAngle3(Math.atan2(ma.y - center.y, ma.x - center.x));
      const angleB = normalizeAngle3(Math.atan2(mb.y - center.y, mb.x - center.x));
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
        const useAngle = normalizeAngle3(angle);
        const cosA = Math.cos(useAngle);
        const sinA = Math.sin(useAngle);
        const satellite = sortedSatellites[nodeIdx++];
        if (!satellite) continue;
        const sb = satellite.node.getBBox();
        const shx = sb.width / 2;
        const shy = sb.height / 2;
        const eOut = rectBoundary2(ehx, ehy, cosA, sinA);
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

// src/attributeLayout.ts
var TAU = Math.PI * 2;
var EDGE_PADDING = 18;
var MAX_R_EXTRA = 220;
var nodeBorderPoint = (n, tx, ty) => {
  const dx = tx - n.x;
  const dy = ty - n.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: n.x, y: n.y };
  const ux = dx / len;
  const uy = dy / len;
  const extent = Math.abs(ux) * n.halfW + Math.abs(uy) * n.halfH;
  return { x: n.x + extent * ux, y: n.y + extent * uy };
};
var rectsOverlap = (ax, ay, ahw, ahh, b, gap) => {
  return Math.abs(ax - b.x) < ahw + b.halfW + gap && Math.abs(ay - b.y) < ahh + b.halfH + gap;
};
var cross2 = (ax, ay, bx, by) => ax * by - ay * bx;
var segmentsIntersect = (x1, y1, x2, y2, x3, y3, x4, y4) => {
  const d1 = cross2(x4 - x3, y4 - y3, x1 - x3, y1 - y3);
  const d2 = cross2(x4 - x3, y4 - y3, x2 - x3, y2 - y3);
  const d3 = cross2(x2 - x1, y2 - y1, x3 - x1, y3 - y1);
  const d4 = cross2(x2 - x1, y2 - y1, x4 - x1, y4 - y1);
  return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
};
var segmentHitsRect = (sx1, sy1, sx2, sy2, cx, cy, hw, hh) => {
  const x1 = cx - hw, x2 = cx + hw;
  const y1 = cy - hh, y2 = cy + hh;
  if (sx1 > x1 && sx1 < x2 && sy1 > y1 && sy1 < y2) return true;
  if (sx2 > x1 && sx2 < x2 && sy2 > y1 && sy2 < y2) return true;
  return segmentsIntersect(sx1, sy1, sx2, sy2, x1, y1, x2, y1) || segmentsIntersect(sx1, sy1, sx2, sy2, x2, y1, x2, y2) || segmentsIntersect(sx1, sy1, sx2, sy2, x2, y2, x1, y2) || segmentsIntersect(sx1, sy1, sx2, sy2, x1, y2, x1, y1);
};
var distributeAttributeAngles = (N, relAngles) => {
  if (N <= 0) return { angles: [], halfWindows: [] };
  const K = relAngles.length;
  if (K === 0) {
    const step = TAU / N;
    return {
      angles: Array.from({ length: N }, (_, i) => i * step),
      halfWindows: Array.from({ length: N }, () => step * 0.48)
    };
  }
  const sorted = relAngles.map((a) => (a % TAU + TAU) % TAU).sort((a, b) => a - b);
  const target = TAU / (N + K);
  const arcs = sorted.map((start, i) => {
    const end = sorted[(i + 1) % K];
    let width = end - start;
    if (width <= 1e-9) width += TAU;
    const raw = Math.max(0, width / target - 1);
    return {
      start,
      width,
      raw,
      count: Math.max(0, Math.round(raw))
    };
  });
  let total = arcs.reduce((s, a) => s + a.count, 0);
  const residual = (a) => a.raw - a.count;
  while (total < N) {
    let best = 0;
    for (let i = 1; i < arcs.length; i++) {
      if (residual(arcs[i]) > residual(arcs[best])) best = i;
    }
    arcs[best].count += 1;
    total += 1;
  }
  while (total > N) {
    let best = -1;
    for (let i = 0; i < arcs.length; i++) {
      if (arcs[i].count <= 0) continue;
      if (best < 0 || residual(arcs[i]) < residual(arcs[best])) best = i;
    }
    if (best < 0) break;
    arcs[best].count -= 1;
    total -= 1;
  }
  const angles = [];
  const halfWindows = [];
  arcs.forEach((arc) => {
    const n = arc.count;
    if (n <= 0) return;
    const step = arc.width / (n + 1);
    const half = step * 0.48;
    for (let j = 0; j < n; j++) {
      angles.push((arc.start + step * (j + 1)) % TAU);
      halfWindows.push(half);
    }
  });
  while (angles.length < N) {
    angles.push(angles.length / N * TAU);
    halfWindows.push(TAU / N * 0.48);
  }
  return {
    angles: angles.slice(0, N),
    halfWindows: halfWindows.slice(0, N)
  };
};
var computeAttributePositions = (graph, newAttrNodes) => {
  const byEntity = /* @__PURE__ */ new Map();
  newAttrNodes.forEach((n) => {
    const pid = n.parentEntity;
    if (!byEntity.has(pid)) byEntity.set(pid, []);
    byEntity.get(pid).push(n);
  });
  const existing = graph.getNodes().map((n) => {
    const m = n.getModel();
    const bbox = n.getBBox();
    return {
      id: m.id,
      x: m.x || 0,
      y: m.y || 0,
      halfW: (bbox.width || 80) / 2,
      halfH: (bbox.height || 40) / 2,
      nodeType: m.nodeType
    };
  });
  const entityMap = new Map(
    existing.filter((n) => n.nodeType === "entity").map((n) => [n.id, n])
  );
  const nodeById = new Map(existing.map((n) => [n.id, n]));
  const obstacleEdges = [];
  graph.getEdges().forEach((e) => {
    const m = e.getModel();
    const s = nodeById.get(m.source);
    const t = nodeById.get(m.target);
    if (!s || !t) return;
    const p1 = nodeBorderPoint(s, t.x, t.y);
    const p2 = nodeBorderPoint(t, s.x, s.y);
    obstacleEdges.push({
      source: m.source,
      target: m.target,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y
    });
  });
  const relAnglesByEntity = /* @__PURE__ */ new Map();
  graph.getEdges().forEach((e) => {
    const em = e.getModel();
    if (em.edgeType !== "entity-relationship" && em.edgeType !== "relationship-entity") return;
    let entId = null;
    let otherId = null;
    if (entityMap.has(em.source)) {
      entId = em.source;
      otherId = em.target;
    } else if (entityMap.has(em.target)) {
      entId = em.target;
      otherId = em.source;
    } else {
      return;
    }
    const other = nodeById.get(otherId);
    if (!other) return;
    const ent = entityMap.get(entId);
    if (!ent) return;
    const ang = Math.atan2(other.y - ent.y, other.x - ent.x);
    if (!relAnglesByEntity.has(entId)) relAnglesByEntity.set(entId, []);
    relAnglesByEntity.get(entId).push(ang);
  });
  const entityOrder = Array.from(byEntity.keys()).sort(
    (a, b) => byEntity.get(b).length - byEntity.get(a).length
  );
  entityOrder.forEach((entityId) => {
    const attrs = byEntity.get(entityId);
    const ent = entityMap.get(entityId);
    if (!ent) return;
    const N = attrs.length;
    if (!N) return;
    attrs.forEach((a) => {
      const sz = estimateAttributeHalfSize(
        a.label,
        a.labelCfg?.style?.fontSize,
        a.keyType === "pk"
      );
      a._halfW = sz.halfW;
      a._halfH = sz.halfH;
    });
    const relAngles = relAnglesByEntity.get(entityId) || [];
    const { angles: slotAngles, halfWindows } = distributeAttributeAngles(N, relAngles);
    attrs.forEach((attr, i) => {
      const baseAngle = slotAngles[i];
      const halfWindow = halfWindows[i];
      const attrHW = attr._halfW;
      const attrHH = attr._halfH;
      const attrBorderTowardEnt = (px2, py2) => {
        const dx2 = ent.x - px2;
        const dy2 = ent.y - py2;
        const len = Math.hypot(dx2, dy2);
        if (len < 1e-9) return { x: px2, y: py2 };
        const ux = dx2 / len;
        const uy = dy2 / len;
        const ex = Math.abs(ux) * attrHW + Math.abs(uy) * attrHH;
        return { x: px2 + ex * ux, y: py2 + ex * uy };
      };
      const tryAngleWithFlags = (angle, flags, maxROverride) => {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const entExtent = Math.abs(dx) * ent.halfW + Math.abs(dy) * ent.halfH;
        const attrExtent = Math.abs(dx) * attrHW + Math.abs(dy) * attrHH;
        const minR = entExtent + attrExtent + EDGE_PADDING;
        const maxR = maxROverride !== void 0 ? maxROverride : entExtent + MAX_R_EXTRA;
        const STEP = 4;
        for (let R = minR; R <= maxR; R += STEP) {
          const px2 = ent.x + R * dx;
          const py2 = ent.y + R * dy;
          const entBorder = nodeBorderPoint(ent, px2, py2);
          const attrBorder = attrBorderTowardEnt(px2, py2);
          const nex1 = entBorder.x, ney1 = entBorder.y;
          const nex2 = attrBorder.x, ney2 = attrBorder.y;
          let bad = false;
          if (flags.rectNode) {
            for (let k = 0; k < existing.length; k++) {
              const n = existing[k];
              if (n.id === entityId) continue;
              if (rectsOverlap(px2, py2, attrHW, attrHH, n, 6)) {
                bad = true;
                break;
              }
            }
            if (bad) continue;
          }
          if (flags.edgeNode) {
            for (let k = 0; k < existing.length; k++) {
              const n = existing[k];
              if (n.id === entityId) continue;
              if (segmentHitsRect(nex1, ney1, nex2, ney2, n.x, n.y, n.halfW + 3, n.halfH + 3)) {
                bad = true;
                break;
              }
            }
            if (bad) continue;
          }
          if (flags.edgeCross) {
            for (let k = 0; k < obstacleEdges.length; k++) {
              const e = obstacleEdges[k];
              if (e.source === entityId || e.target === entityId) continue;
              if (segmentsIntersect(nex1, ney1, nex2, ney2, e.x1, e.y1, e.x2, e.y2)) {
                bad = true;
                break;
              }
            }
            if (bad) continue;
          }
          if (flags.rectPierce) {
            for (let k = 0; k < obstacleEdges.length; k++) {
              const e = obstacleEdges[k];
              if (segmentHitsRect(e.x1, e.y1, e.x2, e.y2, px2, py2, attrHW, attrHH)) {
                bad = true;
                break;
              }
            }
            if (bad) continue;
          }
          return {
            angle,
            R,
            dx,
            dy,
            minR,
            nex1,
            ney1,
            nex2,
            ney2
          };
        }
        return null;
      };
      const slotDeltas = [0];
      const SAMPLES = 8;
      for (let k = 1; k <= SAMPLES; k++) {
        const f = k / SAMPLES * halfWindow;
        slotDeltas.push(f, -f);
      }
      const circleDeltas = [];
      const CIRCLE_SAMPLES = 18;
      for (let k = 1; k < CIRCLE_SAMPLES; k++) {
        let d = k / CIRCLE_SAMPLES * TAU;
        if (d > Math.PI) d -= TAU;
        circleDeltas.push(d);
      }
      const normDev = (d) => {
        let x = (d % TAU + TAU) % TAU;
        if (x > Math.PI) x = TAU - x;
        return x;
      };
      const STRICT = {
        rectNode: true,
        edgeNode: true,
        edgeCross: true,
        rectPierce: true
      };
      const NO_CROSS = {
        rectNode: true,
        edgeNode: true,
        edgeCross: false,
        rectPierce: true
      };
      const NO_CROSS_PIERCE = {
        rectNode: true,
        edgeNode: true,
        edgeCross: false,
        rectPierce: false
      };
      const ONLY_NODES = {
        rectNode: true,
        edgeNode: false,
        edgeCross: false,
        rectPierce: false
      };
      const DEV_PENALTY = 75;
      const findBestInCandidates = (deltas, flags) => {
        let local = null;
        for (const d of deltas) {
          const r = tryAngleWithFlags(baseAngle + d, flags);
          if (!r) continue;
          const score = r.R + normDev(d) * DEV_PENALTY;
          if (!local || score < local.score) local = { ...r, score };
        }
        return local;
      };
      let best = findBestInCandidates(slotDeltas, STRICT);
      if (!best) best = findBestInCandidates(circleDeltas, STRICT);
      if (!best) best = findBestInCandidates(slotDeltas, NO_CROSS);
      if (!best) best = findBestInCandidates(circleDeltas, NO_CROSS);
      if (!best) best = findBestInCandidates(slotDeltas, NO_CROSS_PIERCE);
      if (!best) best = findBestInCandidates(circleDeltas, NO_CROSS_PIERCE);
      if (!best) best = findBestInCandidates(slotDeltas, ONLY_NODES);
      if (!best) {
        const hardCap = Math.max(ent.halfW, ent.halfH) + MAX_R_EXTRA + 160;
        best = tryAngleWithFlags(baseAngle, ONLY_NODES, hardCap);
      }
      if (!best) {
        const dx = Math.cos(baseAngle);
        const dy = Math.sin(baseAngle);
        const entExtent = Math.abs(dx) * ent.halfW + Math.abs(dy) * ent.halfH;
        const attrExtent = Math.abs(dx) * attrHW + Math.abs(dy) * attrHH;
        best = {
          angle: baseAngle,
          R: entExtent + attrExtent + EDGE_PADDING,
          dx,
          dy
        };
      }
      const px = ent.x + best.R * best.dx;
      const py = ent.y + best.R * best.dy;
      attr.x = px;
      attr.y = py;
      const record = {
        id: attr.id,
        x: px,
        y: py,
        halfW: attrHW,
        halfH: attrHH,
        nodeType: "attribute"
      };
      existing.push(record);
      nodeById.set(attr.id, record);
      const eBorder = nodeBorderPoint(ent, px, py);
      const aBorder = nodeBorderPoint(record, ent.x, ent.y);
      obstacleEdges.push({
        source: entityId,
        target: attr.id,
        x1: eBorder.x,
        y1: eBorder.y,
        x2: aBorder.x,
        y2: aBorder.y
      });
    });
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

// src/graph/entityMoveSync.ts
var DEFAULT_SIZES = {
  entity: { width: 120, height: 52 },
  relationship: { width: 82, height: 52 },
  attribute: { width: 90, height: 44 }
};
var FALLBACK_SIZE = { width: 80, height: 40 };
var MIN_ENTITY_RELATION_GAP = 28;
var ATTRIBUTE_DIAMOND_GAP = 8;
var TAU2 = Math.PI * 2;
var positionOf = (node) => ({
  x: typeof node.x === "number" ? node.x : 0,
  y: typeof node.y === "number" ? node.y : 0
});
var fallbackSize = (node) => DEFAULT_SIZES[String(node.nodeType ?? node.type ?? "")] ?? FALLBACK_SIZE;
var safeSize = (node, sizeOf) => {
  const measured = sizeOf?.(node) ?? fallbackSize(node);
  const fallback = fallbackSize(node);
  return {
    width: Number.isFinite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
    height: Number.isFinite(measured.height) && measured.height > 0 ? measured.height : fallback.height
  };
};
var rectBoundary = (rx, ry, ux, uy) => {
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  if (ax < 1e-9) return ry;
  if (ay < 1e-9) return rx;
  return Math.min(rx / ax, ry / ay);
};
var diamondBoundary = (rx, ry, ux, uy) => {
  if (rx <= 0 || ry <= 0) return 0;
  const denom = Math.abs(ux) / rx + Math.abs(uy) / ry;
  return denom > 1e-9 ? 1 / denom : 0;
};
var normalizeAngle2 = (angle) => {
  let x = angle % TAU2;
  if (x < 0) x += TAU2;
  return x;
};
var centerDistance = (a, b) => {
  const pa = positionOf(a);
  const pb = positionOf(b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
};
var startPositionOf = (startPositions, node) => {
  if (!startPositions) return null;
  const point = startPositions.get(node.id);
  if (!point) return null;
  return {
    x: typeof point.x === "number" ? point.x : positionOf(node).x,
    y: typeof point.y === "number" ? point.y : positionOf(node).y
  };
};
var boxesOverlap = (a, as, b, bs, gap = 0) => Math.abs(a.x - b.x) < (as.width + bs.width) / 2 + gap && Math.abs(a.y - b.y) < (as.height + bs.height) / 2 + gap;
function entityIdsForRelationship(relId, nodeById, edges) {
  const ids = [];
  edges.forEach((edge) => {
    if (edge.edgeType !== "entity-relationship" && edge.edgeType !== "relationship-entity") {
      return;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    if (source.id === relId && target.nodeType === "entity") ids.push(target.id);
    if (target.id === relId && source.nodeType === "entity") ids.push(source.id);
  });
  return [...new Set(ids)];
}
function computeRelationshipAnchor(entityA, entityB, relationship, sizeOf) {
  const a = positionOf(entityA);
  const b = positionOf(entityB);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const sizeA = safeSize(entityA, sizeOf);
  const sizeB = safeSize(entityB, sizeOf);
  const sizeR = safeSize(relationship, sizeOf);
  const aBoundary = rectBoundary(sizeA.width / 2, sizeA.height / 2, ux, uy);
  const bBoundary = rectBoundary(sizeB.width / 2, sizeB.height / 2, -ux, -uy);
  const relTowardA = diamondBoundary(sizeR.width / 2, sizeR.height / 2, -ux, -uy);
  const relTowardB = diamondBoundary(sizeR.width / 2, sizeR.height / 2, ux, uy);
  const free = dist - aBoundary - relTowardA - bBoundary - relTowardB;
  const equalGap = Math.max(MIN_ENTITY_RELATION_GAP, free / 2);
  const minFromA = aBoundary + relTowardA + MIN_ENTITY_RELATION_GAP;
  const maxFromA = dist - bBoundary - relTowardB - MIN_ENTITY_RELATION_GAP;
  const idealFromA = aBoundary + relTowardA + equalGap;
  const fromA = maxFromA > minFromA ? Math.min(Math.max(idealFromA, minFromA), maxFromA) : dist / 2;
  return {
    x: a.x + ux * fromA,
    y: a.y + uy * fromA
  };
}
function computeMovedEntityRelationshipTargets(nodes, edges, movedEntityIds, sizeOf, startPositions) {
  const movedIds = new Set(movedEntityIds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationshipTargets = /* @__PURE__ */ new Map();
  const affectedEntityIds = /* @__PURE__ */ new Set();
  nodes.forEach((relationship) => {
    if (relationship.nodeType !== "relationship") return;
    const entityIds = entityIdsForRelationship(relationship.id, nodeById, edges);
    if (!entityIds.some((id) => movedIds.has(id))) return;
    if (entityIds.length === 1) {
      const entity = nodeById.get(entityIds[0]);
      const entityStart = entity ? startPositionOf(startPositions, entity) : null;
      const relStart = startPositionOf(startPositions, relationship);
      if (!entity || !entityStart || !relStart) return;
      const entityNow = positionOf(entity);
      relationshipTargets.set(relationship.id, {
        x: relStart.x + entityNow.x - entityStart.x,
        y: relStart.y + entityNow.y - entityStart.y
      });
      affectedEntityIds.add(entity.id);
      return;
    }
    if (entityIds.length === 2) {
      const entityA = nodeById.get(entityIds[0]);
      const entityB = nodeById.get(entityIds[1]);
      if (!entityA || !entityB) return;
      relationshipTargets.set(
        relationship.id,
        computeRelationshipAnchor(entityA, entityB, relationship, sizeOf)
      );
      affectedEntityIds.add(entityA.id);
      affectedEntityIds.add(entityB.id);
    }
  });
  return { relationshipTargets, affectedEntityIds };
}
function applyNodePositionTargets(nodes, targets) {
  if (!targets.size) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  targets.forEach((target, id) => {
    const node = nodeById.get(id);
    if (!node) return;
    node.x = target.x;
    node.y = target.y;
  });
}
function computeAttributeRotationTargets(nodes, edges, entityIds, sizeOf) {
  const targets = /* @__PURE__ */ new Map();
  const entityIdSet = new Set(entityIds);
  if (!entityIdSet.size) return targets;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const relationshipIdsByEntity = /* @__PURE__ */ new Map();
  edges.forEach((edge) => {
    if (edge.edgeType !== "entity-relationship" && edge.edgeType !== "relationship-entity") {
      return;
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    const entity = source.nodeType === "entity" ? source : target.nodeType === "entity" ? target : null;
    const relationship = source.nodeType === "relationship" ? source : target.nodeType === "relationship" ? target : null;
    if (!entity || !relationship || !entityIdSet.has(entity.id)) return;
    if (!relationshipIdsByEntity.has(entity.id)) relationshipIdsByEntity.set(entity.id, /* @__PURE__ */ new Set());
    relationshipIdsByEntity.get(entity.id).add(relationship.id);
  });
  const attrsByEntity = /* @__PURE__ */ new Map();
  nodes.forEach((node) => {
    if (node.nodeType === "attribute" && typeof node.parentEntity === "string" && entityIdSet.has(node.parentEntity)) {
      if (!attrsByEntity.has(node.parentEntity)) attrsByEntity.set(node.parentEntity, []);
      attrsByEntity.get(node.parentEntity).push(node);
    }
  });
  const relationshipObstacles = nodes.filter((node) => node.nodeType === "relationship").map((node) => ({ node, pos: positionOf(node), size: safeSize(node, sizeOf) }));
  const attributeObstacles = nodes.filter((node) => node.nodeType === "attribute").map((node) => ({
    node,
    pos: positionOf(node),
    size: safeSize(node, sizeOf)
  }));
  const pointFor = (entity, radius, angle) => {
    const c = positionOf(entity);
    return {
      x: c.x + radius * Math.cos(angle),
      y: c.y + radius * Math.sin(angle)
    };
  };
  const candidateOverlaps = (attr, point, attrSize, relatedRelationshipIds) => {
    let hard = 0;
    let soft = 0;
    relationshipObstacles.forEach((obstacle) => {
      const gap = relatedRelationshipIds.has(obstacle.node.id) ? ATTRIBUTE_DIAMOND_GAP : 2;
      if (boxesOverlap(point, attrSize, obstacle.pos, obstacle.size, gap)) hard++;
    });
    attributeObstacles.forEach((obstacle) => {
      if (obstacle.node.id === attr.id) return;
      const target = targets.get(obstacle.node.id);
      const obstaclePos = target ?? obstacle.pos;
      if (boxesOverlap(point, attrSize, obstaclePos, obstacle.size, 4)) soft++;
    });
    return { hard, soft };
  };
  entityIdSet.forEach((entityId) => {
    const entity = nodeById.get(entityId);
    if (!entity) return;
    const attrs = attrsByEntity.get(entityId) ?? [];
    const relatedRelationshipIds = relationshipIdsByEntity.get(entityId) ?? /* @__PURE__ */ new Set();
    if (!attrs.length || !relatedRelationshipIds.size) return;
    attrs.forEach((attr) => {
      const center = positionOf(entity);
      const current = positionOf(attr);
      const radius = centerDistance(entity, attr);
      if (radius < 1e-6) return;
      const attrSize = safeSize(attr, sizeOf);
      const currentScore = candidateOverlaps(attr, current, attrSize, relatedRelationshipIds);
      if (currentScore.hard === 0) return;
      const currentAngle = normalizeAngle2(Math.atan2(current.y - center.y, current.x - center.x));
      let best = null;
      const consider = (angleDelta) => {
        const point = pointFor(entity, radius, currentAngle + angleDelta);
        const score = candidateOverlaps(attr, point, attrSize, relatedRelationshipIds);
        if (!best || score.hard < best.score.hard || score.hard === best.score.hard && score.soft < best.score.soft || score.hard === best.score.hard && score.soft === best.score.soft && Math.abs(angleDelta) < Math.abs(best.angleDelta)) {
          best = { point, score, angleDelta };
        }
      };
      consider(0);
      const STEPS = 72;
      for (let step = 1; step <= STEPS / 2; step++) {
        const delta = step / STEPS * TAU2;
        consider(delta);
        consider(-delta);
        if (best?.score.hard === 0 && best.score.soft === 0) break;
      }
      if (!best || best.score.hard >= currentScore.hard && best.score.soft >= currentScore.soft) {
        return;
      }
      targets.set(attr.id, best.point);
    });
  });
  return targets;
}

// src/graph/autoAvoid.ts
var DEFAULT_SIZE = {
  entity: { width: 120, height: 52 },
  relationship: { width: 82, height: 52 },
  attribute: { width: 90, height: 44 }
};
var FALLBACK_SIZE2 = { width: 80, height: 40 };
var positionOf2 = (node) => ({
  x: typeof node.x === "number" ? node.x : 0,
  y: typeof node.y === "number" ? node.y : 0
});
var fallbackSize2 = (node) => DEFAULT_SIZE[String(node.nodeType ?? node.type ?? "")] ?? FALLBACK_SIZE2;
var safeSize2 = (node, sizeOf) => {
  const fallback = fallbackSize2(node);
  const measured = sizeOf?.(node) ?? fallback;
  return {
    width: Number.isFinite(measured.width) && measured.width > 0 ? measured.width : fallback.width,
    height: Number.isFinite(measured.height) && measured.height > 0 ? measured.height : fallback.height
  };
};
var movePriority = (node) => {
  if (node.nodeType === "attribute") return 2;
  if (node.nodeType === "relationship") return 1;
  return 0;
};
var deterministicSign = (a, b) => a < b ? 1 : -1;
function computeAutoAvoidTargets(nodes, sizeOf, options = {}) {
  if (options.enabled === false) return /* @__PURE__ */ new Map();
  const margin = options.margin ?? 4;
  const maxIterations = options.maxIterations ?? 120;
  const original = new Map(nodes.map((node) => [node.id, positionOf2(node)]));
  const positions = new Map(Array.from(original, ([id, point]) => [id, { ...point }]));
  const sizes = new Map(nodes.map((node) => [node.id, safeSize2(node, sizeOf)]));
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxMove = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const as = sizes.get(a.id) ?? fallbackSize2(a);
      const ap = positions.get(a.id) ?? positionOf2(a);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const bs = sizes.get(b.id) ?? fallbackSize2(b);
        const bp = positions.get(b.id) ?? positionOf2(b);
        const overlapX = (as.width + bs.width) / 2 + margin - Math.abs(bp.x - ap.x);
        const overlapY = (as.height + bs.height) / 2 + margin - Math.abs(bp.y - ap.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const aPriority = movePriority(a);
        const bPriority = movePriority(b);
        if (aPriority === 0 && bPriority === 0) continue;
        let moveA = 0;
        let moveB = 0;
        if (aPriority > bPriority) moveA = 1;
        else if (bPriority > aPriority) moveB = 1;
        else {
          moveA = 0.5;
          moveB = 0.5;
        }
        const separateX = overlapX <= overlapY;
        const rawDelta = separateX ? bp.x - ap.x : bp.y - ap.y;
        const sign = Math.abs(rawDelta) > 1e-6 ? Math.sign(rawDelta) : deterministicSign(a.id, b.id);
        const amount = (separateX ? overlapX : overlapY) + 0.5;
        if (separateX) {
          ap.x -= sign * amount * moveA;
          bp.x += sign * amount * moveB;
        } else {
          ap.y -= sign * amount * moveA;
          bp.y += sign * amount * moveB;
        }
        positions.set(a.id, ap);
        positions.set(b.id, bp);
        maxMove = Math.max(maxMove, amount);
      }
    }
    if (maxMove < 0.1) break;
  }
  const targets = /* @__PURE__ */ new Map();
  nodes.forEach((node) => {
    if (movePriority(node) === 0) return;
    const before = original.get(node.id);
    const after = positions.get(node.id);
    if (!before || !after) return;
    if (Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6) return;
    targets.set(node.id, { x: after.x, y: after.y });
  });
  return targets;
}

// skills/sql2er/scripts/engine/adapter.ts
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

// skills/sql2er/scripts/engine/skeleton.ts
var TAU3 = Math.PI * 2;
var GAP = 8;
var halfDiag = (m) => {
  const s = measureNodeSize(m);
  return Math.hypot(s.width, s.height) / 2;
};
var maxHalfOf = (m) => {
  const s = measureNodeSize(m);
  return Math.max(s.width, s.height) / 2;
};
function ringRadiusFor(entity, attrs) {
  const entR = halfDiag(entity);
  if (!attrs.length) return entR;
  const halves = attrs.map(maxHalfOf);
  const maxHalf = Math.max(...halves);
  const radialMin = entR + maxHalf + GAP;
  const target = TAU3 * 0.92;
  const sum = (R) => halves.reduce((s, h) => s + 2 * Math.asin(Math.min(0.999, (h + GAP / 2) / R)), 0);
  let lo = radialMin;
  let hi = radialMin;
  while (sum(hi) > target && hi < radialMin + 6e3) hi *= 1.5;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) <= target) hi = mid;
    else lo = mid;
  }
  return hi;
}
function smacof(pos, D, iters) {
  const n = pos.length;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let nx = 0;
      let ny = 0;
      let den = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dij = D[i][j];
        const w = 1 / (dij * dij);
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        nx += w * (pos[j].x + dij * dx / dist);
        ny += w * (pos[j].y + dij * dy / dist);
        den += w;
      }
      if (den > 0) {
        pos[i].x = nx / den;
        pos[i].y = ny / den;
      }
    }
  }
}
function removeOverlaps(pos, rad, iters = 400) {
  const n = pos.length;
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        const min = rad[i] + rad[j];
        if (dist < min) {
          const push = (min - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          pos[i].x -= ux * push;
          pos[i].y -= uy * push;
          pos[j].x += ux * push;
          pos[j].y += uy * push;
          moved = Math.max(moved, push);
        }
      }
    }
    if (moved < 0.3) break;
  }
}
function segCross(a1, a2, b1, b2) {
  const eq = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
  const c = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = c(b1, b2, a1);
  const d2 = c(b1, b2, a2);
  const d3 = c(a1, a2, b1);
  const d4 = c(a1, a2, b2);
  return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
}
function countCrossings(pos, E) {
  let total = 0;
  for (let i = 0; i < E.length; i++) {
    for (let j = i + 1; j < E.length; j++) {
      const [a, b] = E[i];
      const [c, d] = E[j];
      if (a === c || a === d || b === c || b === d) continue;
      if (segCross(pos[a], pos[b], pos[c], pos[d])) total++;
    }
  }
  return total;
}
function reduceCrossings(pos, E, n) {
  let cur = countCrossings(pos, E);
  for (let pass = 0; pass < 8 && cur > 0; pass++) {
    let improved = false;
    for (let i = 0; i < n && cur > 0; i++) {
      for (let j = i + 1; j < n; j++) {
        const tmp = pos[i];
        pos[i] = pos[j];
        pos[j] = tmp;
        const nc = countCrossings(pos, E);
        if (nc < cur) {
          cur = nc;
          improved = true;
        } else {
          const t2 = pos[i];
          pos[i] = pos[j];
          pos[j] = t2;
        }
      }
    }
    if (!improved) break;
  }
}
function crossingsAt(pos, myEdges, E) {
  let t = 0;
  for (const [a, b] of myEdges) {
    for (const [c, d] of E) {
      if (a === c || a === d || b === c || b === d) continue;
      if (segCross(pos[a], pos[b], pos[c], pos[d])) t++;
    }
  }
  return t;
}
function diamondDist(i, j, dh, pos, ring) {
  const dist = Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y) || 1;
  const free = dist - ring[i] - ring[j] - 2 * dh;
  const gap = Math.max(20, free / 2);
  return ring[i] + dh + gap;
}
function balanceTwoDiamondEntities(pos, ring, foot, incident, E, rounds) {
  const cands = [...incident.keys()].filter((i) => {
    const inc = incident.get(i);
    return inc.length === 2 && inc[0].nb !== inc[1].nb;
  });
  if (!cands.length) return;
  const overlapFree = (i) => {
    for (let j = 0; j < pos.length; j++) {
      if (j === i) continue;
      if (Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y) < foot[i] + foot[j]) return false;
    }
    return true;
  };
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (let k = 0; k < pos.length; k++) {
    bMinX = Math.min(bMinX, pos[k].x - foot[k]);
    bMaxX = Math.max(bMaxX, pos[k].x + foot[k]);
    bMinY = Math.min(bMinY, pos[k].y - foot[k]);
    bMaxY = Math.max(bMaxY, pos[k].y + foot[k]);
  }
  const inBox = (i) => pos[i].x - foot[i] >= bMinX - 0.5 && pos[i].x + foot[i] <= bMaxX + 0.5 && pos[i].y - foot[i] >= bMinY - 0.5 && pos[i].y + foot[i] <= bMaxY + 0.5;
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (const i of cands) {
      const [eA, eB] = incident.get(i);
      const myEdges = [
        [i, eA.nb],
        [i, eB.nb]
      ];
      const d1 = diamondDist(i, eA.nb, eA.dh, pos, ring);
      const d2 = diamondDist(i, eB.nb, eB.dh, pos, ring);
      const gap0 = Math.abs(d1 - d2);
      if (gap0 < 8) continue;
      const maxOrig = Math.max(d1, d2);
      const ox = pos[i].x;
      const oy = pos[i].y;
      const baseCross = crossingsAt(pos, myEdges, E);
      const DIRS = 24;
      const steps = [gap0 * 0.5, gap0 * 0.25, gap0 * 0.1, 30, 10];
      let bestGap = gap0;
      let bx = ox;
      let by = oy;
      for (let d = 0; d < DIRS; d++) {
        const ux = Math.cos(d / DIRS * TAU3);
        const uy = Math.sin(d / DIRS * TAU3);
        for (const st of steps) {
          pos[i].x = ox + ux * st;
          pos[i].y = oy + uy * st;
          const n1 = diamondDist(i, eA.nb, eA.dh, pos, ring);
          const n2 = diamondDist(i, eB.nb, eB.dh, pos, ring);
          const gap = Math.abs(n1 - n2);
          if (gap < bestGap - 0.5 && Math.max(n1, n2) <= maxOrig + 0.5 && inBox(i) && overlapFree(i) && crossingsAt(pos, myEdges, E) <= baseCross) {
            bestGap = gap;
            bx = pos[i].x;
            by = pos[i].y;
          }
        }
      }
      pos[i].x = bx;
      pos[i].y = by;
      if (bx !== ox || by !== oy) moved = true;
    }
    if (!moved) break;
  }
}
function rotateToTargetAspect(pos, rad, target = 1.5) {
  const n = pos.length;
  if (n < 2) return;
  let cx = 0;
  let cy = 0;
  for (const p of pos) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let bestTheta = 0;
  let bestScore = Infinity;
  let bestArea = Infinity;
  for (let deg = 0; deg < 180; deg++) {
    const th = deg * Math.PI / 180;
    const cos2 = Math.cos(th);
    const sin2 = Math.sin(th);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = pos[i].x - cx;
      const dy = pos[i].y - cy;
      const rx = cx + dx * cos2 - dy * sin2;
      const ry = cy + dx * sin2 + dy * cos2;
      minX = Math.min(minX, rx - rad[i]);
      maxX = Math.max(maxX, rx + rad[i]);
      minY = Math.min(minY, ry - rad[i]);
      maxY = Math.max(maxY, ry + rad[i]);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const aspect = h > 1e-6 ? w / h : Infinity;
    const score = Math.abs(aspect - target);
    const area = w * h;
    if (score < bestScore - 1e-9 || Math.abs(score - bestScore) < 1e-9 && area < bestArea) {
      bestScore = score;
      bestArea = area;
      bestTheta = th;
    }
  }
  if (Math.abs(bestTheta) < 1e-9) return;
  const cos = Math.cos(bestTheta);
  const sin = Math.sin(bestTheta);
  for (let i = 0; i < n; i++) {
    const dx = pos[i].x - cx;
    const dy = pos[i].y - cy;
    pos[i].x = cx + dx * cos - dy * sin;
    pos[i].y = cy + dx * sin + dy * cos;
  }
}
function stressLayout(nodes, edges, ringOverride) {
  const entities = nodes.filter((n) => n.nodeType === "entity");
  const rels = nodes.filter((n) => n.nodeType === "relationship");
  if (!entities.length) return;
  const attrsByE = /* @__PURE__ */ new Map();
  nodes.forEach((n) => {
    if (n.nodeType === "attribute" && typeof n.parentEntity === "string") {
      if (!attrsByE.has(n.parentEntity)) attrsByE.set(n.parentEntity, []);
      attrsByE.get(n.parentEntity).push(n);
    }
  });
  const ring = new Map(
    entities.map((e) => [
      e.id,
      ringOverride?.get(e.id) ?? ringRadiusFor(e, attrsByE.get(e.id) ?? [])
    ])
  );
  const footprint = new Map(
    entities.map((e) => {
      const attrs = attrsByE.get(e.id) ?? [];
      const maxAttr = attrs.length ? Math.max(...attrs.map(maxHalfOf)) : 0;
      return [e.id, ring.get(e.id) + maxAttr + 6];
    })
  );
  const relEnts = /* @__PURE__ */ new Map();
  rels.forEach((r) => relEnts.set(r.id, []));
  edges.forEach((e) => {
    if (e.edgeType === "entity-relationship") relEnts.get(e.target)?.push(e.source);
    else if (e.edgeType === "relationship-entity") relEnts.get(e.source)?.push(e.target);
  });
  const binRels = rels.map((r) => ({ r, es: [...new Set(relEnts.get(r.id) ?? [])] })).filter((x) => x.es.length === 2);
  const eidx = new Map(entities.map((e, i) => [e.id, i]));
  const N = entities.length;
  const desired = /* @__PURE__ */ new Map();
  const adj = /* @__PURE__ */ new Map();
  entities.forEach((e) => adj.set(e.id, /* @__PURE__ */ new Set()));
  const key = (a, b) => a < b ? a + "|" + b : b + "|" + a;
  binRels.forEach(({ r, es }) => {
    const [a, b] = es;
    const d = ring.get(a) + ring.get(b) + 2 * halfDiag(r) + 2 * 20;
    const k = key(a, b);
    if (!desired.has(k) || d < desired.get(k)) desired.set(k, d);
    adj.get(a).add(b);
    adj.get(b).add(a);
  });
  const seen = /* @__PURE__ */ new Set();
  const comps = [];
  entities.map((e) => e.id).sort().forEach((id) => {
    if (seen.has(id)) return;
    const stack = [id];
    const comp = [];
    seen.add(id);
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
    comps.push(comp);
  });
  const laid = comps.map((ids) => {
    const local = ids.map((id) => entities[eidx.get(id)]);
    const m = local.length;
    const li = new Map(ids.map((id, i) => [id, i]));
    const INF = 1e9;
    const D = Array.from({ length: m }, () => new Array(m).fill(INF));
    for (let i = 0; i < m; i++) D[i][i] = 0;
    ids.forEach(
      (a) => (adj.get(a) ?? []).forEach((b) => {
        if (!li.has(b)) return;
        const d = desired.get(key(a, b)) ?? 300;
        const ia = li.get(a);
        const ib = li.get(b);
        D[ia][ib] = Math.min(D[ia][ib], d);
        D[ib][ia] = Math.min(D[ib][ia], d);
      })
    );
    for (let k = 0; k < m; k++)
      for (let i = 0; i < m; i++)
        for (let j = 0; j < m; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];
    const pos = local.map((e, i) => ({
      x: typeof e.x === "number" ? e.x : Math.cos(i / m * TAU3) * 200,
      y: typeof e.y === "number" ? e.y : Math.sin(i / m * TAU3) * 200
    }));
    const rads = local.map((e) => footprint.get(e.id));
    const idSet = new Set(ids);
    const edgesLocal = [];
    const incident = /* @__PURE__ */ new Map();
    binRels.forEach(({ r, es }) => {
      const [a, b] = es;
      if (!idSet.has(a) || !idSet.has(b)) return;
      const ia = li.get(a);
      const ib = li.get(b);
      edgesLocal.push([ia, ib]);
      const dh = halfDiag(r);
      if (!incident.has(ia)) incident.set(ia, []);
      if (!incident.has(ib)) incident.set(ib, []);
      incident.get(ia).push({ nb: ib, dh });
      incident.get(ib).push({ nb: ia, dh });
    });
    if (m > 1) {
      smacof(pos, D, 300);
      removeOverlaps(pos, rads, 400);
      if (edgesLocal.length > 1) {
        reduceCrossings(pos, edgesLocal, m);
        removeOverlaps(pos, rads, 400);
      }
      const ringLocal = local.map((e) => ring.get(e.id));
      balanceTwoDiamondEntities(pos, ringLocal, rads, incident, edgesLocal, 16);
    }
    rotateToTargetAspect(pos, rads);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    local.forEach((e, i) => {
      const r = footprint.get(e.id);
      minX = Math.min(minX, pos[i].x - r);
      minY = Math.min(minY, pos[i].y - r);
      maxX = Math.max(maxX, pos[i].x + r);
      maxY = Math.max(maxY, pos[i].y + r);
    });
    const map = /* @__PURE__ */ new Map();
    local.forEach((e, i) => map.set(e.id, { x: pos[i].x - minX, y: pos[i].y - minY }));
    return { ids, pos: map, w: maxX - minX, h: maxY - minY };
  });
  laid.sort((a, b) => b.w * b.h - a.w * a.h);
  const PAD = 80;
  let cy = 0;
  laid.forEach((c) => {
    c.ids.forEach((id) => {
      const p = c.pos.get(id);
      entities[eidx.get(id)].x = p.x;
      entities[eidx.get(id)].y = cy + p.y;
    });
    cy += c.h + PAD;
  });
  const epos = new Map(entities.map((e) => [e.id, { x: e.x ?? 0, y: e.y ?? 0 }]));
  const groups = /* @__PURE__ */ new Map();
  binRels.forEach((br) => {
    const k = key(br.es[0], br.es[1]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(br);
  });
  groups.forEach((list) => {
    const [a, b] = list[0].es;
    const pa = epos.get(a);
    const pb = epos.get(b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const px = -uy;
    const py = ux;
    const mid = (list.length - 1) / 2;
    list.forEach((br, i) => {
      const dh = halfDiag(br.r);
      const free = dist - ring.get(a) - ring.get(b) - 2 * dh;
      const gap = Math.max(20, free / 2);
      const fromA = ring.get(a) + dh + gap;
      const off = (i - mid) * (dh * 2 + 16);
      br.r.x = pa.x + ux * fromA + px * off;
      br.r.y = pa.y + uy * fromA + py * off;
    });
  });
  rels.forEach((r) => {
    const es = [...new Set(relEnts.get(r.id) ?? [])];
    if (es.length === 1) {
      const a = epos.get(es[0]);
      if (a) {
        r.x = a.x;
        r.y = a.y - (ring.get(es[0]) + 40);
      }
    }
  });
  const MARGIN = 3;
  const entBox = entities.map((e) => {
    const s = measureNodeSize(e);
    return { id: e.id, x: e.x ?? 0, y: e.y ?? 0, hw: s.width / 2, hh: s.height / 2 };
  });
  const relBox = rels.map((r) => {
    const s = measureNodeSize(r);
    return { r, hw: s.width / 2, hh: s.height / 2 };
  });
  for (let iter = 0; iter < 200; iter++) {
    let moved = 0;
    for (let i = 0; i < relBox.length; i++) {
      const bi = relBox[i];
      const ri = bi.r;
      for (const eb of entBox) {
        const dx = (ri.x ?? 0) - eb.x;
        const dy = (ri.y ?? 0) - eb.y;
        const ox = bi.hw + eb.hw + MARGIN - Math.abs(dx);
        const oy = bi.hh + eb.hh + MARGIN - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) ri.x = (ri.x ?? 0) + (dx >= 0 ? ox : -ox);
          else ri.y = (ri.y ?? 0) + (dy >= 0 ? oy : -oy);
          moved = Math.max(moved, Math.min(ox, oy));
        }
      }
      for (let j = i + 1; j < relBox.length; j++) {
        const bj = relBox[j];
        const rj = bj.r;
        const dx = (ri.x ?? 0) - (rj.x ?? 0);
        const dy = (ri.y ?? 0) - (rj.y ?? 0);
        const ox = bi.hw + bj.hw + MARGIN - Math.abs(dx);
        const oy = bi.hh + bj.hh + MARGIN - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) {
            const push = (dx >= 0 ? ox : -ox) / 2;
            ri.x = (ri.x ?? 0) + push;
            rj.x = (rj.x ?? 0) - push;
          } else {
            const push = (dy >= 0 ? oy : -oy) / 2;
            ri.y = (ri.y ?? 0) + push;
            rj.y = (rj.y ?? 0) - push;
          }
          moved = Math.max(moved, Math.min(ox, oy));
        }
      }
    }
    if (moved < 0.3) break;
  }
}

// skills/sql2er/scripts/engine/ops.ts
var CANVAS_W = 1200;
var CANVAS_H = 800;
var DEFAULT_SETTINGS = {
  colored: true,
  comment: false,
  hideAttrs: false,
  fontScale: 1,
  attrMode: "auto",
  autoAvoid: true
};
function clampFontScale2(scale) {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.6, Math.max(0.4, scale));
}
function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    fontScale: clampFontScale2(settings.fontScale),
    autoAvoid: settings.autoAvoid !== false
  };
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
function runLayoutOnGraph(kind, graph, nodes, edges) {
  if (kind === "none") return;
  if (kind === "optimal") {
    forceAlignLayout(graph, CANVAS_W);
    stressLayout(nodes, edges);
  } else if (kind === "arrange") {
    arrangeLayout(graph);
  }
}
function generate(opts) {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...opts.settings ?? {} });
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
  const layout = opts.layout ?? "optimal";
  runLayoutOnGraph(layout, graph, nodes, edges);
  if (layout === "optimal" && settings.attrMode === "auto") settings.attrMode = "moderate";
  const state = { version: 1, input: opts.input, format, settings, nodes, edges };
  applyAttrMode(state);
  if (layout === "optimal") tightenCompact(state);
  applyAutoAvoid(state);
  return state;
}
function runLayout(state, kind) {
  state.settings = normalizeSettings(state.settings);
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  runLayoutOnGraph(kind, graph, state.nodes, state.edges);
  if (kind === "optimal" && state.settings.attrMode === "auto")
    state.settings.attrMode = "moderate";
  applyAttrMode(state);
  if (kind === "optimal") tightenCompact(state);
  applyAutoAvoid(state);
  return { ...state };
}
function setFontScale(state, delta) {
  state.settings = normalizeSettings(state.settings);
  const fontScale = deltaToScale(delta);
  const settings = { ...state.settings, fontScale };
  const next = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings);
  applyAttrMode(next);
  applyAutoAvoid(next);
  return next;
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
  state.settings = normalizeSettings(state.settings);
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
  applyAutoAvoid(state);
  return { ...state };
}
var currentLabelMode = (state) => state.settings.comment ? "comment" : "name";
function ensureBaseLabels(node) {
  const current = String(node.label ?? node.id);
  if (node.nameLabel === void 0) node.nameLabel = current;
  if (node.commentLabel === void 0) node.commentLabel = node.nameLabel;
}
function baseLabelFor(node, mode) {
  ensureBaseLabels(node);
  if (mode === "comment")
    return String(node.commentLabel || node.nameLabel || node.label || node.id);
  return String(node.nameLabel || node.label || node.id);
}
function applyLabelsByMode(state) {
  const mode = currentLabelMode(state);
  state.nodes.forEach((node) => {
    const n = node;
    n.label = typeof n.manualLabel === "string" ? n.manualLabel : baseLabelFor(n, mode);
  });
}
function restyleAfterLabelEdit(state) {
  state.settings = normalizeSettings(state.settings);
  styleAndSize(state.nodes, state.edges, state.settings);
  applyAttrMode(state);
  applyAutoAvoid(state);
}
function resolveNodeById(state, id) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node)
    throw new Error(`Could not resolve "${id}" to a node id. Use an exact id from describe.`);
  return node;
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
function setLabel(state, id, label) {
  const node = resolveNodeById(state, id);
  ensureBaseLabels(node);
  node.manualLabel = label;
  node.label = label;
  restyleAfterLabelEdit(state);
  return { state: { ...state }, resolved: [{ id: node.id, label }] };
}
function setLabels(state, labels) {
  const entries = Object.entries(labels);
  if (!entries.length) throw new Error("labels batch requires at least one id:label entry.");
  const nodes = entries.map(([id, label]) => {
    if (typeof label !== "string") throw new Error(`Label for "${id}" must be a string.`);
    return [resolveNodeById(state, id), label];
  });
  nodes.forEach(([node, label]) => {
    ensureBaseLabels(node);
    node.manualLabel = label;
    node.label = label;
  });
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: nodes.map(([node]) => ({ id: node.id, label: String(node.label ?? "") }))
  };
}
function resetLabels(state, idOrAll) {
  const nodes = idOrAll === "all" ? state.nodes : [resolveNodeById(state, idOrAll)];
  nodes.forEach((node) => {
    delete node.manualLabel;
    node.label = baseLabelFor(node, currentLabelMode(state));
  });
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: nodes.map((node) => ({ id: node.id, label: String(node.label ?? "") }))
  };
}
function setLabelMode(state, mode) {
  state.settings = { ...state.settings, comment: mode === "comment" };
  applyLabelsByMode(state);
  restyleAfterLabelEdit(state);
  return {
    state: { ...state },
    resolved: state.nodes.map((node) => ({ id: node.id, label: String(node.label ?? "") }))
  };
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
function captureNodePositions(nodes) {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0
      }
    ])
  );
}
function syncMovedEntities(state, entityIds, startPositions) {
  const { relationshipTargets, affectedEntityIds } = computeMovedEntityRelationshipTargets(
    state.nodes,
    state.edges,
    entityIds,
    measureNodeSize,
    startPositions
  );
  applyNodePositionTargets(state.nodes, relationshipTargets);
  const attrTargets = computeAttributeRotationTargets(
    state.nodes,
    state.edges,
    affectedEntityIds,
    measureNodeSize
  );
  applyNodePositionTargets(state.nodes, attrTargets);
}
var TAU4 = Math.PI * 2;
var normAngle = (a) => {
  let x = a % TAU4;
  if (x < 0) x += TAU4;
  return x;
};
function placeAttributesCompact(state) {
  const attrs = state.nodes.filter((n) => n.nodeType === "attribute");
  if (!attrs.length) return;
  const skeleton = state.nodes.filter((n) => n.nodeType !== "attribute");
  const graph = createHeadlessGraph(skeleton, state.edges, CANVAS_W, CANVAS_H);
  computeAttributePositions(
    graph,
    attrs
  );
}
function placeAttributesModerate(state) {
  const entById = new Map(state.nodes.filter((n) => n.nodeType === "entity").map((e) => [e.id, e]));
  const relById = new Map(
    state.nodes.filter((n) => n.nodeType === "relationship").map((r) => [r.id, r])
  );
  const attrsByEntity = /* @__PURE__ */ new Map();
  state.nodes.forEach((n) => {
    if (n.nodeType === "attribute" && typeof n.parentEntity === "string" && entById.has(n.parentEntity)) {
      if (!attrsByEntity.has(n.parentEntity)) attrsByEntity.set(n.parentEntity, []);
      attrsByEntity.get(n.parentEntity).push(n);
    }
  });
  const relAngles = /* @__PURE__ */ new Map();
  state.edges.forEach((e) => {
    if (e.edgeType !== "entity-relationship" && e.edgeType !== "relationship-entity") return;
    const entId = entById.has(e.source) ? e.source : entById.has(e.target) ? e.target : null;
    const relId = relById.has(e.source) ? e.source : relById.has(e.target) ? e.target : null;
    if (!entId || !relId) return;
    const en = entById.get(entId);
    const rn = relById.get(relId);
    const ang = normAngle(Math.atan2((rn.y ?? 0) - (en.y ?? 0), (rn.x ?? 0) - (en.x ?? 0)));
    if (!relAngles.has(entId)) relAngles.set(entId, []);
    relAngles.get(entId).push(ang);
  });
  const radiusOf = (m) => {
    const s = measureNodeSize(m);
    return Math.hypot(s.width, s.height) / 2;
  };
  const obstacles = [];
  state.nodes.forEach((n) => {
    if (n.nodeType === "entity" || n.nodeType === "relationship") {
      const s = measureNodeSize(n);
      obstacles.push({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, w: s.width, h: s.height });
    }
  });
  const hits = (x, y, w, h, skipId) => obstacles.some(
    (o) => o.id !== skipId && Math.abs(x - o.x) < (w + o.w) / 2 - 2 && Math.abs(y - o.y) < (h + o.h) / 2 - 2
  );
  const centre = /* @__PURE__ */ new Map();
  state.nodes.forEach((n) => {
    if (n.nodeType === "entity" || n.nodeType === "relationship")
      centre.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  });
  const relSegs = [];
  state.edges.forEach((e) => {
    if (e.edgeType === "entity-relationship" || e.edgeType === "relationship-entity") {
      const s = centre.get(e.source);
      const t = centre.get(e.target);
      if (s && t) relSegs.push({ s, t, a: e.source, b: e.target });
    }
  });
  const properCross = (a1, a2, b1, b2) => {
    const eq = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
    if (eq(a1, b1) || eq(a1, b2) || eq(a2, b1) || eq(a2, b2)) return false;
    const c = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    const d1 = c(b1, b2, a1);
    const d2 = c(b1, b2, a2);
    const d3 = c(a1, a2, b1);
    const d4 = c(a1, a2, b2);
    return (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0);
  };
  const connectorCrosses = (ex, ey, x, y, eid) => relSegs.some(
    (seg) => seg.a !== eid && seg.b !== eid && properCross({ x: ex, y: ey }, { x, y }, seg.s, seg.t)
  );
  const segHitsBox = (p1, p2, bx, by, bw, bh) => {
    const minx = bx - bw / 2;
    const maxx = bx + bw / 2;
    const miny = by - bh / 2;
    const maxy = by + bh / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    let t0 = 0;
    let t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    return clip(-dx, p1.x - minx) && clip(dx, maxx - p1.x) && clip(-dy, p1.y - miny) && clip(dy, maxy - p1.y) && t1 > t0;
  };
  const boxPierced = (x, y, w, h) => relSegs.some((seg) => segHitsBox(seg.s, seg.t, x, y, w, h));
  const angleOf = (m, cx, cy) => normAngle(Math.atan2((m.y ?? 0) - cy, (m.x ?? 0) - cx));
  const order = [...attrsByEntity.keys()].sort(
    (a, b) => (attrsByEntity.get(b)?.length ?? 0) - (attrsByEntity.get(a)?.length ?? 0)
  );
  order.forEach((eid) => {
    const attrs = attrsByEntity.get(eid);
    const ent = entById.get(eid);
    const ecx = ent.x ?? 0;
    const ecy = ent.y ?? 0;
    const entR = radiusOf(ent);
    const rels = relAngles.get(eid) ?? [];
    const GAP2 = 8;
    const items = attrs.map((at) => {
      const s = measureNodeSize(at);
      return { at, s, half: Math.max(s.width, s.height) / 2 };
    });
    const n = items.length;
    const maxHalf = Math.max(...items.map((it) => it.half));
    const angWidth = (half, R2) => 2 * Math.asin(Math.min(0.999, (half + GAP2 / 2) / R2));
    const angularSum = (R2) => items.reduce((s, it) => s + angWidth(it.half, R2), 0);
    const radialMin = entR + maxHalf + GAP2;
    const target = TAU4 * 0.92;
    let lo = radialMin;
    let hi = radialMin;
    while (angularSum(hi) > target && hi < radialMin + 6e3) hi *= 1.5;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (angularSum(mid) <= target) hi = mid;
      else lo = mid;
    }
    const R = hi;
    const ordered = items.slice().sort((a, b) => angleOf(a.at, ecx, ecy) - angleOf(b.at, ecx, ecy));
    const widths = ordered.map((it) => angWidth(it.half, R));
    const slack = Math.max(0, TAU4 - widths.reduce((s, w) => s + w, 0)) / Math.max(1, n);
    const baseAngles = [];
    let acc = 0;
    for (let i = 0; i < ordered.length; i++) {
      acc += slack / 2 + widths[i] / 2;
      baseAngles.push(acc);
      acc += widths[i] / 2 + slack / 2;
    }
    let phase = ordered.length ? angleOf(ordered[0].at, ecx, ecy) - baseAngles[0] : 0;
    if (rels.length) {
      const TRIES = 36;
      let best = -Infinity;
      for (let t = 0; t < TRIES; t++) {
        const ph = t / TRIES * TAU4;
        let minGap = Infinity;
        for (const ba of baseAngles) {
          const slot = normAngle(ph + ba);
          for (const r of rels) {
            let d = Math.abs(slot - r);
            d = Math.min(d, TAU4 - d);
            if (d < minGap) minGap = d;
          }
        }
        if (minGap > best) {
          best = minGap;
          phase = ph;
        }
      }
    }
    ordered.forEach((it, i) => {
      const baseAng = phase + baseAngles[i];
      const win = widths[i] / 2 + slack;
      const offsets = [0];
      const SLIDE = 10;
      for (let k = 1; k <= SLIDE; k++) {
        const off = k / SLIDE * win;
        offsets.push(off, -off);
      }
      let bx = ecx + R * Math.cos(baseAng);
      let by = ecy + R * Math.sin(baseAng);
      let placed = false;
      for (const off of offsets) {
        const a2 = baseAng + off;
        const x = ecx + R * Math.cos(a2);
        const y = ecy + R * Math.sin(a2);
        if (!hits(x, y, it.s.width, it.s.height, eid) && !connectorCrosses(ecx, ecy, x, y, eid) && !boxPierced(x, y, it.s.width, it.s.height)) {
          bx = x;
          by = y;
          placed = true;
          break;
        }
      }
      if (!placed)
        for (const off of offsets) {
          const a2 = baseAng + off;
          const x = ecx + R * Math.cos(a2);
          const y = ecy + R * Math.sin(a2);
          if (!hits(x, y, it.s.width, it.s.height, eid)) {
            bx = x;
            by = y;
            break;
          }
        }
      it.at.x = bx;
      it.at.y = by;
      obstacles.push({ id: it.at.id, x: bx, y: by, w: it.s.width, h: it.s.height });
    });
  });
  const obById = new Map(obstacles.map((o) => [o.id, o]));
  state.nodes.forEach((at) => {
    if (at.nodeType !== "attribute" || typeof at.parentEntity !== "string") return;
    const ent = entById.get(at.parentEntity);
    if (!ent) return;
    const s = measureNodeSize(at);
    const cx = at.x ?? 0;
    const cy = at.y ?? 0;
    if (!boxPierced(cx, cy, s.width, s.height) && !hits(cx, cy, s.width, s.height, at.id) && !connectorCrosses(ent.x ?? 0, ent.y ?? 0, cx, cy, at.parentEntity))
      return;
    const ecx = ent.x ?? 0;
    const ecy = ent.y ?? 0;
    const half = Math.max(s.width, s.height) / 2;
    const curR = Math.hypot(cx - ecx, cy - ecy) || radiusOf(ent) + half;
    const curAng = normAngle(Math.atan2(cy - ecy, cx - ecx));
    let best = null;
    const clearCandidate = (x, y) => !hits(x, y, s.width, s.height, at.id) && !boxPierced(x, y, s.width, s.height) && !connectorCrosses(ecx, ecy, x, y, at.parentEntity);
    const consider = (x, y) => {
      if (!clearCandidate(x, y)) return;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { x, y, d };
    };
    const localStep = Math.max(6, Math.min(12, half / 4));
    const localMax = Math.max(220, half * 8);
    for (let r = localStep; r <= localMax; r += localStep) {
      const steps = Math.max(24, Math.ceil(TAU4 * r / localStep));
      for (let k = 0; k < steps; k++) {
        const ang = k / steps * TAU4;
        consider(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
      }
      if (best && best.d + localStep < r) break;
    }
    for (let dr = 0; dr <= 8; dr++) {
      const R2 = curR + dr * (half * 0.6 + 6);
      const steps = Math.max(36, Math.round(TAU4 * R2 / (half + 6)));
      for (let k = 0; k < steps; k++) {
        const ang = curAng + k / steps * TAU4;
        const x = ecx + R2 * Math.cos(ang);
        const y = ecy + R2 * Math.sin(ang);
        consider(x, y);
      }
    }
    if (best) {
      at.x = best.x;
      at.y = best.y;
      const ob = obById.get(at.id);
      if (ob) {
        ob.x = best.x;
        ob.y = best.y;
      }
    }
  });
}
function applyAttrMode(state) {
  if (state.settings.attrMode === "compact") placeAttributesCompact(state);
  else if (state.settings.attrMode === "moderate") placeAttributesModerate(state);
}
function applyAutoAvoid(state) {
  state.settings = normalizeSettings(state.settings);
  if (!state.settings.autoAvoid) return;
  const targets = computeAutoAvoidTargets(state.nodes, measureNodeSize);
  applyNodePositionTargets(state.nodes, targets);
}
function measuredRingRadii(state) {
  const attrsBy = /* @__PURE__ */ new Map();
  state.nodes.forEach((n) => {
    if (n.nodeType === "attribute" && typeof n.parentEntity === "string") {
      if (!attrsBy.has(n.parentEntity)) attrsBy.set(n.parentEntity, []);
      attrsBy.get(n.parentEntity).push(n);
    }
  });
  const radii = /* @__PURE__ */ new Map();
  state.nodes.forEach((e) => {
    if (e.nodeType !== "entity") return;
    const ex = e.x ?? 0;
    const ey = e.y ?? 0;
    const es = measureNodeSize(e);
    let maxR = Math.hypot(es.width, es.height) / 2;
    (attrsBy.get(e.id) ?? []).forEach((a) => {
      maxR = Math.max(maxR, Math.hypot((a.x ?? 0) - ex, (a.y ?? 0) - ey));
    });
    const moderateR = ringRadiusFor(e, attrsBy.get(e.id) ?? []);
    radii.set(e.id, Math.min(maxR, moderateR));
  });
  return radii;
}
function tightenCompact(state) {
  if (state.settings.attrMode !== "compact") return;
  const radii = measuredRingRadii(state);
  stressLayout(state.nodes, state.edges, radii);
  applyAttrMode(state);
}
function setAttrMode(state, mode) {
  state.settings = normalizeSettings(state.settings);
  const settings = { ...state.settings, attrMode: mode };
  const next = { ...state, settings };
  styleAndSize(next.nodes, next.edges, settings);
  applyAttrMode(next);
  applyAutoAvoid(next);
  return next;
}
function settle(state) {
  state.settings = normalizeSettings(state.settings);
  const graph = styleAndSize(state.nodes, state.edges, state.settings);
  arrangeLayout(graph);
  applyAttrMode(state);
  applyAutoAvoid(state);
}
function setAutoAvoid(state, enabled) {
  state.settings = normalizeSettings({ ...state.settings, autoAvoid: enabled });
  if (enabled) applyAutoAvoid(state);
  return { ...state };
}
function move(state, arg, x, y, raw) {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  const startPositions = captureNodePositions(state.nodes);
  const dx = x - (typeof node.x === "number" ? node.x : 0);
  const dy = y - (typeof node.y === "number" ? node.y : 0);
  translateCluster(state, node, dx, dy);
  syncMovedEntities(state, [node.id], startPositions);
  if (!raw) settle(state);
  return { state: { ...state }, resolved: [{ id: node.id, label: String(node.label) }] };
}
function nudge(state, arg, dx, dy, raw) {
  const node = resolveNode(state, arg);
  if (!node) throw new Error(unresolved(state, arg));
  const startPositions = captureNodePositions(state.nodes);
  translateCluster(state, node, dx, dy);
  syncMovedEntities(state, [node.id], startPositions);
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
  const startPositions = captureNodePositions(state.nodes);
  translateCluster(state, a, bx - ax, by - ay);
  translateCluster(state, b, ax - bx, ay - by);
  syncMovedEntities(state, [a.id, b.id], startPositions);
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
function splitComponents(state) {
  const entities = state.nodes.filter((n) => n.nodeType === "entity");
  const rels = state.nodes.filter((n) => n.nodeType === "relationship");
  const relEnts = /* @__PURE__ */ new Map();
  rels.forEach((r) => relEnts.set(r.id, []));
  state.edges.forEach((e) => {
    if (e.edgeType === "entity-relationship" && relEnts.has(e.target))
      relEnts.get(e.target).push(e.source);
    if (e.edgeType === "relationship-entity" && relEnts.has(e.source))
      relEnts.get(e.source).push(e.target);
  });
  const adj = /* @__PURE__ */ new Map();
  entities.forEach((e) => adj.set(e.id, /* @__PURE__ */ new Set()));
  relEnts.forEach((ids) => {
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        if (adj.has(uniq[i]) && adj.has(uniq[j])) {
          adj.get(uniq[i]).add(uniq[j]);
          adj.get(uniq[j]).add(uniq[i]);
        }
      }
    }
  });
  const seen = /* @__PURE__ */ new Set();
  const comps = [];
  entities.map((e) => e.id).sort().forEach((id) => {
    if (seen.has(id)) return;
    const stack = [id];
    const comp = [];
    seen.add(id);
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
    comps.push(comp);
  });
  const usedNames = /* @__PURE__ */ new Map();
  const nameFor = (entIds) => {
    const labelOf = (id) => {
      const n2 = state.nodes.find((x) => x.id === id);
      return String(n2?.nameLabel ?? n2?.label ?? id);
    };
    const rep = entIds.slice().sort(
      (a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0) || labelOf(a).localeCompare(labelOf(b))
    )[0];
    let base = labelOf(rep).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!base) base = "component";
    const n = usedNames.get(base) ?? 0;
    usedNames.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  };
  return comps.map((entIds) => {
    const entSet = new Set(entIds);
    const relIds = new Set(
      rels.filter((r) => {
        const ids = [...new Set(relEnts.get(r.id) ?? [])];
        return ids.length > 0 && ids.every((id) => entSet.has(id));
      }).map((r) => r.id)
    );
    const nodeSet = /* @__PURE__ */ new Set([...entSet, ...relIds]);
    state.nodes.forEach((n) => {
      if (n.nodeType === "attribute" && n.parentEntity && entSet.has(n.parentEntity))
        nodeSet.add(n.id);
    });
    const nodes = state.nodes.filter((n) => nodeSet.has(n.id));
    const edges = state.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
    return { name: nameFor(entIds), state: { ...state, nodes, edges } };
  });
}

// skills/sql2er/scripts/engine/cli.ts
import { parse as parsePath } from "node:path";

// skills/sql2er/scripts/engine/describe.ts
var num = (v, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var short = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
var segCross2 = (a1, a2, b1, b2) => {
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
  const hasRel = /* @__PURE__ */ new Set();
  relationships.forEach((r) => {
    if (r.fromId) hasRel.add(r.fromId);
    if (r.toId) hasRel.add(r.toId);
  });
  const isolated = entities.filter((e) => !hasRel.has(e.id)).map((e) => e.id);
  const segs = relationships.filter((r) => r.fromId && r.toId && !r.selfLoop).map((r) => ({ r, a: entityById.get(r.fromId), b: entityById.get(r.toId) })).filter((s) => s.a && s.b);
  const crossings = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const si = segs[i];
      const sj = segs[j];
      const shared = si.a.id === sj.a.id || si.a.id === sj.b.id || si.b.id === sj.a.id || si.b.id === sj.b.id;
      if (shared) continue;
      if (segCross2(si.a, si.b, sj.a, sj.b)) crossings.push([si.r, sj.r]);
    }
  }
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
  const boxes = coreInfos.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    attr: false
  }));
  attrsByEntity.forEach(
    (list) => list.forEach((m) => {
      const b = bboxOf.get(m.id);
      if (b)
        boxes.push({ id: m.id, x: num(m.x), y: num(m.y), w: b.width, h: b.height, attr: true });
    })
  );
  let attrOverlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a.attr && !b.attr) continue;
      if (Math.abs(a.x - b.x) < a.w / 2 + b.w / 2 - 2 && Math.abs(a.y - b.y) < a.h / 2 + b.h / 2 - 2)
        attrOverlaps++;
    }
  }
  const centerOf = (id) => {
    const b = bboxOf.get(id);
    return b ? { x: b.centerX, y: b.centerY } : null;
  };
  const edgeSegs = edges.map((e) => {
    const m = e.getModel();
    const s = centerOf(m.source);
    const t = centerOf(m.target);
    return s && t ? { s, t, source: m.source, target: m.target, type: m.edgeType } : null;
  }).filter((x) => !!x);
  let attrCrossings = 0;
  for (let i = 0; i < edgeSegs.length; i++) {
    for (let j = i + 1; j < edgeSegs.length; j++) {
      const a = edgeSegs[i];
      const b = edgeSegs[j];
      if (a.type !== "entity-attribute" && b.type !== "entity-attribute") continue;
      if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target)
        continue;
      if (segCross2(a.s, a.t, b.s, b.t)) attrCrossings++;
    }
  }
  const relLineSegs = edgeSegs.filter(
    (s) => s.type === "entity-relationship" || s.type === "relationship-entity"
  );
  const attrBoxes = [];
  attrsByEntity.forEach(
    (list) => list.forEach((m) => {
      const b = bboxOf.get(m.id);
      if (b) attrBoxes.push({ x: num(m.x), y: num(m.y), w: b.width, h: b.height });
    })
  );
  const segHitsBox = (p1, p2, bx, by, bw, bh) => {
    const inset = 2;
    const minx = bx - bw / 2 + inset;
    const maxx = bx + bw / 2 - inset;
    const miny = by - bh / 2 + inset;
    const maxy = by + bh / 2 - inset;
    if (minx >= maxx || miny >= maxy) return false;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    let t0 = 0;
    let t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    return clip(-dx, p1.x - minx) && clip(dx, maxx - p1.x) && clip(-dy, p1.y - miny) && clip(dy, maxy - p1.y) && t1 > t0;
  };
  for (const seg of relLineSegs) {
    for (const ab of attrBoxes) {
      if (segHitsBox(seg.s, seg.t, ab.x, ab.y, ab.w, ab.h)) attrCrossings++;
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
    attrOverlaps,
    attrCrossings,
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
  if (scene.attrOverlaps > 0)
    L.push(`  \u26A0 attribute overlaps: ${scene.attrOverlaps}  (try \`attrs compact\`)`);
  if (scene.attrCrossings > 0)
    L.push(`  \u26A0 attribute-line crossings: ${scene.attrCrossings}  (try \`attrs compact\`)`);
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
    `  metrics: crossings=${scene.crossings.length} overlaps=${scene.overlaps.length} attrOverlaps=${scene.attrOverlaps} attrCrossings=${scene.attrCrossings} bbox=${w}\xD7${h} aspect=${aspect} edgeLen=${Math.round(edgeLen)}`
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
    const fromL = r.fromId ? scene.entityById.get(r.fromId)?.label ?? r.fromId : "?";
    const toL = r.toId ? scene.entityById.get(r.toId)?.label ?? r.toId : "?";
    const self = r.selfLoop ? " [self]" : "";
    L.push(
      `    ${r.id}  ${r.label}  ${fromL}\u2192${toL}${self}  ${r.cardFrom}:${r.cardTo}  (${Math.round(r.x)},${Math.round(r.y)})`
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
      attrOverlaps: s.attrOverlaps,
      attrCrossings: s.attrCrossings,
      isolated: s.isolated.map((id) => s.entityById.get(id)?.label ?? id),
      bbox: { w: Math.round(s.bbox.maxX - s.bbox.minX), h: Math.round(s.bbox.maxY - s.bbox.minY) }
    }
  };
}

// skills/sql2er/scripts/engine/exporters.ts
import { spawnSync } from "node:child_process";

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

// skills/sql2er/scripts/engine/exporters.ts
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
var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function exportPng(state) {
  const svg = exportSvg(state);
  const candidates = [process.env.SQL2ER_RSVG_CONVERT, "rsvg-convert", "rsvg-convert.exe"].filter(
    (cmd) => !!cmd
  );
  const missing = [];
  for (const cmd of candidates) {
    const result = spawnSync(cmd, ["--format", "png", "-"], {
      input: svg,
      maxBuffer: 200 * 1024 * 1024
    });
    if (result.error) {
      if (result.error.code === "ENOENT") {
        missing.push(cmd);
        continue;
      }
      throw new Error(`PNG export failed using ${cmd}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.toString("utf8").trim();
      throw new Error(`PNG export failed using ${cmd}: ${stderr || `exit ${result.status}`}`);
    }
    const png = result.stdout ?? Buffer.alloc(0);
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`PNG export failed using ${cmd}: converter did not return PNG data`);
    }
    return png;
  }
  throw new Error(
    `PNG export requires rsvg-convert on PATH or SQL2ER_RSVG_CONVERT. Tried: ${missing.join(", ") || "none"}.`
  );
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
  const selfLoopControl = (s, t, off) => {
    const dx = t.cx - s.cx;
    const dy = t.cy - s.cy;
    const dist = Math.hypot(dx, dy) || 1;
    return { x: (s.cx + t.cx) / 2 + -dy / dist * off, y: (s.cy + t.cy) / 2 + dx / dist * off };
  };
  const isArc = (e) => e.type === "self-loop-arc" && typeof e.curveOffset === "number" && e.curveOffset !== 0;
  state.edges.forEach((e) => {
    const s = sized.get(e.source);
    const t = sized.get(e.target);
    if (!s || !t) return;
    if (isArc(e)) {
      const c = selfLoopControl(s, t, e.curveOffset);
      parts.push(
        `<path d="M ${s.cx.toFixed(1)} ${s.cy.toFixed(1)} Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${t.cx.toFixed(1)} ${t.cy.toFixed(1)}" fill="none" stroke="#000" stroke-width="1.5"/>`
      );
    } else {
      parts.push(
        `<line x1="${s.cx.toFixed(1)}" y1="${s.cy.toFixed(1)}" x2="${t.cx.toFixed(1)}" y2="${t.cy.toFixed(1)}" stroke="#000" stroke-width="1.5"/>`
      );
    }
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
      const tw = getTextWidth(String(n.label ?? ""), Number(fontSize));
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
    let mx = (s.cx + t.cx) / 2;
    let my = (s.cy + t.cy) / 2;
    if (isArc(e)) {
      const c = selfLoopControl(s, t, e.curveOffset);
      mx = (mx + c.x) / 2;
      my = (my + c.y) / 2;
    }
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

// skills/sql2er/scripts/engine/cli.ts
var ATTR_MODES = ["auto", "compact", "moderate"];
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
var hasFlag = (flags, name) => Object.prototype.hasOwnProperty.call(flags, name);
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
function readLabels(flags) {
  const hasFile = typeof flags.file === "string";
  const hasText = typeof flags.text === "string";
  if (hasFile === hasText)
    throw new Error("labels batch requires exactly one of --file or --text.");
  const raw = hasFile ? rf(resolve(process.cwd(), flags.file), "utf8") : flags.text;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('labels batch expects a JSON object: {"node-id":"label"}.');
  }
  const labels = {};
  Object.entries(parsed).forEach(([id, label]) => {
    if (typeof label !== "string") throw new Error(`Label for "${id}" must be a string.`);
    labels[id] = label;
  });
  return labels;
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
      --hide-attrs                   skeleton only \u2014 generate NO attributes (tighter,
                                     cleaner layout); decided here, not at export
      --attrs auto|compact|moderate  attribute orbit mode (default auto)
      --auto-avoid true|false    resolve node overlaps after layout/edit (default true)
      --layout optimal|arrange|none  (default optimal)
  describe                 Print skeleton + diagnostics + ASCII map.
      --full                         also list attributes
      --focus <id|label>             zoom into one entity
      --json                         machine-readable scene
  layout <optimal|arrange>  Re-run a layout. optimal = stress-spaced skeleton
                           (rooms for attribute rings; the recommended default);
                           arrange = settle current positions.
  move <id|label> <x> <y>  Place an entity (attributes and diamonds follow). Then settles
                           with one arrange pass unless --raw.
  nudge <id|label> <dx> <dy>   Shift by a delta. --raw to skip the settle pass.
  swap <a> <b>             Exchange two entities' positions. --raw to skip settle.
  rotate <degrees>         Rotate the whole diagram about its centre (shapes stay upright).
  attrs <auto|compact|moderate>  Re-place attribute ellipses. compact = tightest
                           non-overlapping pack; moderate = uniform even ring. Persists.
  labels set <id> <label> Set a manual node label.
  labels batch --file labels.json | --text '{"id":"label"}'
                           Set many manual labels at once.
  labels reset <id|all>    Clear manual labels and restore the active name/comment mode.
  labels mode <name|comment>
                           Switch generated labels without clearing manual labels.
  fontsize <delta>         0 = default; negative = smaller, positive = larger (\u2248\xB10.1/step).
  avoid <on|off>           Toggle automatic node overlap avoidance for this state.
  export <drawio|svg|png|json> Write output. --out <file> (else stdout).
      --split                        one diagram per disconnected component
                                     (--out base.ext -> base-<name>.ext per component)
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
        layout: typeof flags.layout === "string" ? flags.layout : "optimal",
        settings: {
          ...DEFAULT_SETTINGS,
          colored: boolFlag(flags.colored, true),
          comment: boolFlag(flags.comment),
          hideAttrs: boolFlag(flags["hide-attrs"]),
          attrMode: ATTR_MODES.includes(flags.attrs) ? flags.attrs : "auto",
          autoAvoid: boolFlag(flags["auto-avoid"], true)
        }
      });
      saveState(flags, state);
      printState(state, flags);
      break;
    }
    case "attrs": {
      const mode = _[1];
      if (!ATTR_MODES.includes(mode)) throw new Error("attrs <auto|compact|moderate>");
      const next = setAttrMode(loadState(flags), mode);
      saveState(flags, next);
      printState(next, flags);
      break;
    }
    case "labels": {
      const sub = _[1];
      if (sub === "set") {
        const id = _[2];
        const label = _[3];
        if (!id || label === void 0) throw new Error("labels set <id> <label>");
        const { state, resolved } = setLabel(loadState(flags), id, label);
        saveState(flags, state);
        process.stdout.write(`labeled ${resolved.map((r) => `${r.id}="${r.label}"`).join(", ")}
`);
        printState(state, flags);
        break;
      }
      if (sub === "batch") {
        const { state, resolved } = setLabels(loadState(flags), readLabels(flags));
        saveState(flags, state);
        process.stdout.write(`labeled ${resolved.length} nodes
`);
        printState(state, flags);
        break;
      }
      if (sub === "reset") {
        const idOrAll = _[2];
        if (!idOrAll) throw new Error("labels reset <id|all>");
        const { state, resolved } = resetLabels(loadState(flags), idOrAll);
        saveState(flags, state);
        process.stdout.write(`reset ${resolved.length} labels
`);
        printState(state, flags);
        break;
      }
      if (sub === "mode") {
        const mode = _[2];
        if (mode !== "name" && mode !== "comment") throw new Error("labels mode <name|comment>");
        const { state } = setLabelMode(loadState(flags), mode);
        saveState(flags, state);
        process.stdout.write(`labelMode=${mode}
`);
        printState(state, flags);
        break;
      }
      throw new Error(
        "labels set <id> <label> | labels batch --file <json> | labels batch --text <json> | labels reset <id|all> | labels mode <name|comment>"
      );
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
      if (kind !== "optimal" && kind !== "arrange") throw new Error("layout <optimal|arrange>");
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
    case "avoid": {
      const mode = _[1];
      if (mode !== "on" && mode !== "off") throw new Error("avoid <on|off>");
      const next = setAutoAvoid(loadState(flags), mode === "on");
      saveState(flags, next);
      process.stdout.write(`autoAvoid=${next.settings.autoAvoid ? "on" : "off"}
`);
      printState(next, flags);
      break;
    }
    case "export": {
      if (hasFlag(flags, "hide-attrs")) {
        throw new Error(
          "--hide-attrs is only valid on generate; export writes whatever the saved state contains."
        );
      }
      const fmt = _[1];
      const state = loadState(flags);
      const render = (s) => {
        if (fmt === "drawio") return { out: exportDrawio(s), ext: "drawio" };
        if (fmt === "svg") return { out: exportSvg(s), ext: "svg" };
        if (fmt === "png") return { out: exportPng(s), ext: "png" };
        if (fmt === "json") return { out: exportJson(s), ext: "json" };
        throw new Error("export <drawio|svg|png|json>");
      };
      const writeExport = (file, out2, ext2) => {
        writeFileSync(
          resolve(process.cwd(), file),
          out2,
          typeof out2 === "string" ? "utf8" : void 0
        );
        const bytes = typeof out2 === "string" ? Buffer.byteLength(out2) : out2.length;
        process.stdout.write(`wrote ${file} (${ext2}, ${bytes} bytes)
`);
      };
      if (boolFlag(flags.split)) {
        const comps = splitComponents(state);
        if (comps.length <= 1) {
          process.stdout.write(`only 1 component \u2014 nothing to split; exporting whole diagram
`);
        } else if (fmt === "png" && typeof flags.out !== "string") {
          throw new Error("export png --split requires --out because PNG output is binary.");
        } else if (typeof flags.out === "string") {
          const p = parsePath(flags.out);
          comps.forEach((c) => {
            const { out: out2, ext: ext2 } = render(c.state);
            const file = `${p.dir ? p.dir + "/" : ""}${p.name}-${c.name}.${ext2}`;
            writeExport(file, out2, ext2);
          });
          break;
        } else {
          comps.forEach((c) => {
            const { out: out2 } = render(c.state);
            process.stdout.write(`=== component: ${c.name} ===
${out2}
`);
          });
          break;
        }
      }
      const { out, ext } = render(state);
      if (typeof flags.out === "string") {
        writeExport(flags.out, out, ext);
      } else if (Buffer.isBuffer(out)) {
        process.stdout.write(out);
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
