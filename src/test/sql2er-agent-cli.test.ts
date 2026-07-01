import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agent = resolve(repoRoot, "skills/sql2er/scripts/sql2er-agent.mjs");

const schema = `
CREATE TABLE users (
  id INT PRIMARY KEY,
  name TEXT
);
CREATE TABLE posts (
  id INT PRIMARY KEY,
  user_id INT,
  title TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

function runAgent(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [agent, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function hasRsvgConvert(): boolean {
  return spawnSync("rsvg-convert", ["--version"], { encoding: "utf8" }).status === 0;
}

type AgentState = {
  version: 1;
  input: string;
  format: "sql";
  settings: {
    colored: boolean;
    comment: boolean;
    hideAttrs: boolean;
    fontScale: number;
    attrMode: "auto" | "compact" | "moderate";
    autoAvoid?: boolean;
  };
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    nodeType: string;
    x: number;
    y: number;
    parentEntity?: string;
    keyType?: string;
    isSelfLoop?: boolean;
    nameLabel?: string;
    commentLabel?: string;
    manualLabel?: string;
  }>;
  edges: Array<{ id: string; source: string; target: string; edgeType: string; label?: string }>;
};

function readState(path: string): AgentState {
  return JSON.parse(readFileSync(path, "utf8")) as AgentState;
}

function readEmbeddedStateFromHtml(html: string): unknown {
  const match = html.match(
    /<script type="application\/json" id="sql2er-embedded-state">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("missing embedded state script");
  return JSON.parse(match[1]) as unknown;
}

function attrPosition(state: AgentState, id: string): { x: number; y: number } {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return { x: node.x, y: node.y };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

function segmentsIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const d1 = cross2(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
  const d2 = cross2(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);
  const d3 = cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  const d4 = cross2(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function aabbOverlap(
  a: { x: number; y: number },
  as: { width: number; height: number },
  b: { x: number; y: number },
  bs: { width: number; height: number },
  margin = 4,
): boolean {
  return (
    Math.abs(a.x - b.x) < (as.width + bs.width) / 2 + margin &&
    Math.abs(a.y - b.y) < (as.height + bs.height) / 2 + margin
  );
}

function nodePosition(state: AgentState, id: string): { x: number; y: number } {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return { x: node.x, y: node.y };
}

function exportedBoxes(statePath: string): Array<{
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  const exported = runAgent(["export", "json", "--state", statePath]);
  expect(exported.status).toBe(0);
  return JSON.parse(exported.stdout).nodes;
}

function boxById(
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  id: string,
) {
  const box = boxes.find((n) => n.id === id);
  if (!box) throw new Error(`missing exported node ${id}`);
  return box;
}

function expectPointOnSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const area2 = (point.x - a.x) * dy - (point.y - a.y) * dx;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;

  expect(Math.abs(area2)).toBeLessThan(1e-6);
  expect(t).toBeGreaterThan(0);
  expect(t).toBeLessThan(1);
}

function makeAttributeRingState(count: number): AgentState {
  const nodes: AgentState["nodes"] = [
    { id: "entity-owner", type: "entity", label: "owner", nodeType: "entity", x: 0, y: 0 },
  ];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    nodes.push({
      id: `attr-owner-a${i}`,
      type: "attribute",
      label: `a${i}`,
      nodeType: "attribute",
      parentEntity: "entity-owner",
      keyType: "normal",
      x: 220 * Math.cos(angle),
      y: 220 * Math.sin(angle),
    });
  }
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes,
    edges: nodes
      .filter((n) => n.nodeType === "attribute")
      .map((n) => ({
        id: `edge-owner-${n.id}`,
        source: "entity-owner",
        target: n.id,
        edgeType: "entity-attribute",
      })),
  };
}

function makeRelabelState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes: [
      {
        id: "entity-users-0",
        type: "entity",
        label: "users",
        nameLabel: "users",
        commentLabel: "User account",
        nodeType: "entity",
        x: 100,
        y: 100,
      },
      {
        id: "attr-users-name-0-1",
        type: "attribute",
        label: "name",
        nameLabel: "name",
        commentLabel: "Full name",
        nodeType: "attribute",
        parentEntity: "entity-users-0",
        keyType: "normal",
        x: 100,
        y: 180,
      },
      {
        id: "rel-posts-users-user_id-0",
        type: "relationship",
        label: "user_id",
        nameLabel: "user_id",
        commentLabel: "author",
        nodeType: "relationship",
        x: 220,
        y: 100,
      },
    ],
    edges: [
      {
        id: "edge-users-name",
        source: "entity-users-0",
        target: "attr-users-name-0-1",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-users-rel",
        source: "entity-users-0",
        target: "rel-posts-users-user_id-0",
        edgeType: "entity-relationship",
        label: "1",
      },
    ],
  };
}

function makeOverlappingState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
    },
    nodes: [
      { id: "entity-users", type: "entity", label: "users", nodeType: "entity", x: 0, y: 0 },
      {
        id: "attr-users-name",
        type: "attribute",
        label: "name",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 8,
        y: 0,
      },
    ],
    edges: [
      {
        id: "edge-users-name",
        source: "entity-users",
        target: "attr-users-name",
        edgeType: "entity-attribute",
      },
    ],
  };
}

function makeAttributeConnectorCrossingState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
    },
    nodes: [
      { id: "entity-users", type: "entity", label: "users", nodeType: "entity", x: 0, y: 0 },
      {
        id: "attr-users-name",
        type: "attribute",
        label: "name",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 160,
        y: 0,
      },
      { id: "entity-orders", type: "entity", label: "orders", nodeType: "entity", x: 80, y: -140 },
      {
        id: "rel-orders-users",
        type: "relationship",
        label: "placed by",
        nodeType: "relationship",
        x: 80,
        y: 140,
      },
    ],
    edges: [
      {
        id: "edge-users-name",
        source: "entity-users",
        target: "attr-users-name",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-orders-rel",
        source: "entity-orders",
        target: "rel-orders-users",
        edgeType: "entity-relationship",
      },
    ],
  };
}

function makeAttributeDetailState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes: [
      { id: "entity-users", type: "entity", label: "users", nodeType: "entity", x: 0, y: 0 },
      {
        id: "attr-users-name",
        type: "attribute",
        label: "name",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 160,
        y: 0,
      },
      {
        id: "attr-users-email",
        type: "attribute",
        label: "email",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 0,
        y: 30,
      },
      { id: "entity-orders", type: "entity", label: "orders", nodeType: "entity", x: 80, y: -140 },
      {
        id: "rel-orders-users",
        type: "relationship",
        label: "placed by",
        nodeType: "relationship",
        x: 80,
        y: 140,
      },
    ],
    edges: [
      {
        id: "edge-users-name",
        source: "entity-users",
        target: "attr-users-name",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-users-email",
        source: "entity-users",
        target: "attr-users-email",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-orders-rel",
        source: "entity-orders",
        target: "rel-orders-users",
        edgeType: "entity-relationship",
      },
    ],
  };
}

function makeAttributeLinePiercesAttributeState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: false,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes: [
      { id: "entity-users", type: "entity", label: "users", nodeType: "entity", x: 0, y: 0 },
      {
        id: "attr-users-name",
        type: "attribute",
        label: "name",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 160,
        y: 0,
      },
      {
        id: "attr-users-email",
        type: "attribute",
        label: "email",
        nodeType: "attribute",
        parentEntity: "entity-users",
        x: 80,
        y: 0,
      },
    ],
    edges: [
      {
        id: "edge-users-name",
        source: "entity-users",
        target: "attr-users-name",
        edgeType: "entity-attribute",
      },
      {
        id: "edge-users-email",
        source: "entity-users",
        target: "attr-users-email",
        edgeType: "entity-attribute",
      },
    ],
  };
}

function makePlanarCrossingState(): AgentState {
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: true,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes: [
      { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 0, y: 0 },
      { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 100, y: 100 },
      { id: "entity-c", type: "entity", label: "c", nodeType: "entity", x: 0, y: 100 },
      { id: "entity-d", type: "entity", label: "d", nodeType: "entity", x: 100, y: 0 },
      {
        id: "rel-a-b",
        type: "relationship",
        label: "a_b",
        nodeType: "relationship",
        x: 50,
        y: 50,
      },
      {
        id: "rel-c-d",
        type: "relationship",
        label: "c_d",
        nodeType: "relationship",
        x: 50,
        y: 50,
      },
    ],
    edges: [
      {
        id: "edge-a-rel",
        source: "entity-a",
        target: "rel-a-b",
        edgeType: "entity-relationship",
        label: "N",
      },
      {
        id: "edge-rel-b",
        source: "rel-a-b",
        target: "entity-b",
        edgeType: "relationship-entity",
        label: "1",
      },
      {
        id: "edge-c-rel",
        source: "entity-c",
        target: "rel-c-d",
        edgeType: "entity-relationship",
        label: "N",
      },
      {
        id: "edge-rel-d",
        source: "rel-c-d",
        target: "entity-d",
        edgeType: "relationship-entity",
        label: "1",
      },
    ],
  };
}

function makeK33State(): AgentState {
  const left = ["a", "b", "c"];
  const right = ["x", "y", "z"];
  const nodes: AgentState["nodes"] = [];
  left.forEach((id, index) => {
    nodes.push({
      id: `entity-${id}`,
      type: "entity",
      label: id,
      nodeType: "entity",
      x: 0,
      y: index * 120,
    });
  });
  right.forEach((id, index) => {
    nodes.push({
      id: `entity-${id}`,
      type: "entity",
      label: id,
      nodeType: "entity",
      x: 360,
      y: index * 120,
    });
  });
  const edges: AgentState["edges"] = [];
  left.forEach((l) => {
    right.forEach((r, index) => {
      const relId = `rel-${l}-${r}`;
      nodes.push({
        id: relId,
        type: "relationship",
        label: `${l}_${r}`,
        nodeType: "relationship",
        x: 180,
        y: index * 120,
      });
      edges.push(
        {
          id: `edge-${l}-${r}-from`,
          source: `entity-${l}`,
          target: relId,
          edgeType: "entity-relationship",
          label: "N",
        },
        {
          id: `edge-${l}-${r}-to`,
          source: relId,
          target: `entity-${r}`,
          edgeType: "relationship-entity",
          label: "1",
        },
      );
    });
  });
  return {
    version: 1,
    input: "manual",
    format: "sql",
    settings: {
      colored: true,
      comment: false,
      hideAttrs: true,
      fontScale: 1,
      attrMode: "auto",
      autoAvoid: false,
    },
    nodes,
    edges,
  };
}

describe("sql2er agent CLI attribute visibility", () => {
  it("prints parser warnings while generate succeeds with partially parsed SQL", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const badSchema = `
        CREATE TABLE broken (
          id INT PRIMARY KEY,
          account_id,
          CONSTRAINT fk_bad FOREIGN KEY (account_id) REFERENCES
        );
      `;

      const generated = runAgent(["generate", "--format", "sql", "--text", badSchema, "--state", state]);

      expect(generated.status).toBe(0);
      expect(generated.stderr).toContain("parser warning:");
      expect(generated.stderr).toContain('line 3: column "account_id" in table "broken" has no type');
      expect(generated.stderr).toContain(
        'line 4: foreign key in table "broken" was not recognized',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints parser warnings while generate succeeds with partially parsed DBML", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const input = resolve(dir, "input.dbml");
      const badDbml = `-- 示例 DBML，请在此处粘贴您的 DBML 或 SQL 语句
Table 用户 {
  编号 INT [pk, increment]
  用户名 VARCHAR(255) [not null]
  邮箱 VARCHAR(255) [unique]
  创建时间 TIMESTAMP
}

Table 国家 {
  编号 INT [pk]
  名称 VARCHAR(255 [not null]
}

Table 文章 {
  文章编号 INT [pk]
  内容 TEXT
}

Ref: 用户.属于 > 国家.编号
Ref: 文章.作者 >
`;
      writeFileSync(input, badDbml);

      const generated = runAgent(["generate", "--input", input, "--state", state]);

      expect(generated.status).toBe(0);
      expect(generated.stderr).toContain("parser warning:");
      expect(generated.stderr).toContain(
        'line 11: column "名称" in table "国家" has malformed type "VARCHAR(255"',
      );
      expect(generated.stderr).toContain("line 20: ref statement was not recognized");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects explicit --format auto", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");

      const generated = runAgent(["generate", "--format", "auto", "--text", schema, "--state", state]);

      expect(generated.status).not.toBe(0);
      expect(generated.stderr).toContain("generate --format accepts only sql or dbml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints parser warnings when auto-detect cannot generate a graph", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const generated = runAgent([
        "generate",
        "--text",
        "CREATE TABLE audit AS SELECT 1;",
        "--state",
        state,
      ]);

      expect(generated.status).not.toBe(0);
      expect(generated.stderr).toContain("error: No tables parsed from input (tried auto-detect).");
      expect(generated.stderr).toContain("parser warning:");
      expect(generated.stderr).toContain(
        'line 1: CREATE TABLE "audit" AS SELECT was skipped because columns cannot be inferred',
      );
      expect(existsSync(state)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints parser warnings when malformed DBML cannot generate a graph", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const input = resolve(dir, "input.dbml");
      writeFileSync(
        input,
        `Table dangling {
  id int [pk]
`,
      );

      const generated = runAgent(["generate", "--input", input, "--state", state]);

      expect(generated.status).not.toBe(0);
      expect(generated.stderr).toContain("error: No tables parsed from input (tried auto-detect).");
      expect(generated.stderr).toContain("parser warning:");
      expect(generated.stderr).toContain(
        'line 1: Table "dangling" was skipped because its block is not closed',
      );
      expect(existsSync(state)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decides hidden attributes at generate time and exports the stored skeleton only", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const generated = runAgent(["generate", "--text", schema, "--state", state, "--hide-attrs"]);

      expect(generated.status).toBe(0);

      const exported = runAgent(["export", "json", "--state", state]);
      expect(exported.status).toBe(0);
      const json = JSON.parse(exported.stdout) as {
        nodes: { type: string }[];
        edges: { type: string }[];
      };

      expect(json.nodes.some((n) => n.type === "attribute")).toBe(false);
      expect(json.edges.some((e) => e.type === "entity-attribute")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose attribute hiding as an export-time option", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const generated = runAgent(["generate", "--text", schema, "--state", state]);
      expect(generated.status).toBe(0);

      const exported = runAgent(["export", "json", "--state", state, "--hide-attrs"]);

      expect(exported.status).not.toBe(0);
      expect(exported.stderr).toContain("--hide-attrs is only valid on generate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI export formats", () => {
  it("exports a single-file embedded HTML editor seeded with the saved state", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const out = resolve(dir, "er.html");
      const generated = runAgent(["generate", "--text", schema, "--state", state]);
      expect(generated.status).toBe(0);

      const missingLang = runAgent(["export", "html", "--state", state, "--out", out]);
      expect(missingLang.status).not.toBe(0);
      expect(missingLang.stderr).toContain("export html requires --lang zh|en");

      const exported = runAgent(["export", "html", "--state", state, "--out", out, "--lang", "en"]);

      expect(exported.status).toBe(0);
      expect(exported.stdout).toContain("wrote");
      const html = readFileSync(out, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain('id="sql2er-embedded-state"');
      expect(html).toContain('id="sql2er-embedded-config"');
      expect(html).toContain('"lang":"en"');
      expect(html).toContain("CREATE TABLE users");
      expect(html).toContain("entity-users");
      expect(html).toContain("<style>");
      expect(html).toContain("<script>");
      expect(html).not.toContain('src="/src/main.tsx"');
      expect(html).not.toContain("<link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports embedded HTML with a required Chinese language setting", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const out = resolve(dir, "er.html");
      const generated = runAgent(["generate", "--text", schema, "--state", state]);
      expect(generated.status).toBe(0);

      const exported = runAgent(["export", "html", "--state", state, "--out", out, "--lang", "zh"]);

      expect(exported.status).toBe(0);
      const html = readFileSync(out, "utf8");
      expect(html).toContain('<html lang="zh-CN">');
      expect(html).toContain('"lang":"zh"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves parser warnings in exported embedded HTML state", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const input = resolve(dir, "input.dbml");
      const out = resolve(dir, "er.html");
      writeFileSync(
        input,
        `Table users {
  id int [pk]
  missing_type
}
`,
      );

      const generated = runAgent(["generate", "--input", input, "--state", state]);
      expect(generated.status).toBe(0);
      expect(generated.stderr).toContain("parser warning:");

      const exported = runAgent(["export", "html", "--state", state, "--out", out, "--lang", "zh"]);
      expect(exported.status).toBe(0);
      const embeddedState = readEmbeddedStateFromHtml(readFileSync(out, "utf8")) as {
        parserWarnings?: Array<{ message: string }>;
      };

      expect(embeddedState.parserWarnings?.map((warning) => warning.message)).toEqual([
        'line 3: column "missing_type" in table "users" has no type',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasRsvgConvert())("exports PNG files", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const out = resolve(dir, "er.png");
      const generated = runAgent(["generate", "--text", schema, "--state", state]);
      expect(generated.status).toBe(0);

      const exported = runAgent(["export", "png", "--state", state, "--out", out]);

      expect(exported.status).toBe(0);
      expect(exported.stdout).toContain("wrote");
      const bytes = readFileSync(out);
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI labels", () => {
  it("sets batch labels from inline JSON and resets one or all labels to the active mode", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeRelabelState()));

      const relBefore = nodePosition(readState(state), "rel-posts-users-user_id-0");
      const set = runAgent([
        "labels",
        "set",
        "rel-posts-users-user_id-0",
        "placed by",
        "--state",
        state,
      ]);
      expect(set.status).toBe(0);

      const batch = runAgent([
        "labels",
        "batch",
        "--text",
        '{"entity-users-0":"Customer","attr-users-name-0-1":"Display name"}',
        "--state",
        state,
      ]);
      expect(batch.status).toBe(0);

      const relabeled = readState(state);
      expect(relabeled.nodes.find((n) => n.id === "entity-users-0")?.label).toBe("Customer");
      expect(relabeled.nodes.find((n) => n.id === "attr-users-name-0-1")?.label).toBe(
        "Display name",
      );
      expect(relabeled.nodes.find((n) => n.id === "rel-posts-users-user_id-0")?.label).toBe(
        "placed by",
      );
      expect(nodePosition(relabeled, "rel-posts-users-user_id-0")).toEqual(relBefore);

      const resetOne = runAgent(["labels", "reset", "attr-users-name-0-1", "--state", state]);
      expect(resetOne.status).toBe(0);
      expect(readState(state).nodes.find((n) => n.id === "attr-users-name-0-1")?.label).toBe(
        "name",
      );

      const resetAll = runAgent(["labels", "reset", "all", "--state", state]);
      expect(resetAll.status).toBe(0);
      const reset = readState(state);
      expect(reset.nodes.find((n) => n.id === "entity-users-0")?.label).toBe("users");
      expect(reset.nodes.find((n) => n.id === "rel-posts-users-user_id-0")?.label).toBe("user_id");
      expect(reset.nodes.some((n) => n.manualLabel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads batch labels from a file and switches base label mode without clearing manual labels", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      const labels = resolve(dir, "labels.json");
      writeFileSync(state, JSON.stringify(makeRelabelState()));
      writeFileSync(labels, JSON.stringify({ "rel-posts-users-user_id-0": "placed by" }));

      const set = runAgent(["labels", "set", "entity-users-0", "Customer", "--state", state]);
      expect(set.status).toBe(0);
      const batch = runAgent(["labels", "batch", "--file", labels, "--state", state]);
      expect(batch.status).toBe(0);
      const mode = runAgent(["labels", "mode", "comment", "--state", state]);
      expect(mode.status).toBe(0);

      const commentMode = readState(state);
      expect(commentMode.settings.comment).toBe(true);
      expect(commentMode.nodes.find((n) => n.id === "entity-users-0")?.label).toBe("Customer");
      expect(commentMode.nodes.find((n) => n.id === "attr-users-name-0-1")?.label).toBe(
        "Full name",
      );
      expect(commentMode.nodes.find((n) => n.id === "rel-posts-users-user_id-0")?.label).toBe(
        "placed by",
      );

      const resetAll = runAgent(["labels", "reset", "all", "--state", state]);
      expect(resetAll.status).toBe(0);
      const reset = readState(state);
      expect(reset.nodes.find((n) => n.id === "entity-users-0")?.label).toBe("User account");
      expect(reset.nodes.find((n) => n.id === "rel-posts-users-user_id-0")?.label).toBe("author");
      expect(reset.nodes.some((n) => n.manualLabel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI layout modes", () => {
  it("arranges from current positions without first force-aligning", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 1000, y: 1000 },
            {
              id: "rel-a-b",
              type: "relationship",
              label: "a_b",
              nodeType: "relationship",
              x: 1150,
              y: 1000,
            },
            { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 1300, y: 1000 },
          ],
          edges: [
            {
              id: "edge-a-rel",
              source: "entity-a",
              target: "rel-a-b",
              edgeType: "entity-relationship",
              label: "N",
            },
            {
              id: "edge-rel-b",
              source: "rel-a-b",
              target: "entity-b",
              edgeType: "relationship-entity",
              label: "1",
            },
          ],
        } satisfies AgentState),
      );

      const arranged = runAgent(["layout", "arrange", "--state", state]);

      expect(arranged.status).toBe(0);
      expect(readState(state).nodes.find((n) => n.id === "entity-a")?.x).toBeGreaterThan(900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI auto avoidance", () => {
  it("auto-avoids overlaps by default after a mutating command", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeOverlappingState()));

      const adjusted = runAgent(["fontsize", "0", "--state", state]);

      expect(adjusted.status).toBe(0);
      const next = readState(state);
      const boxes = exportedBoxes(state);
      expect(next.settings.autoAvoid).toBe(true);
      expect(nodePosition(next, "entity-users")).toEqual({ x: 0, y: 0 });
      const entity = boxById(boxes, "entity-users");
      const attr = boxById(boxes, "attr-users-name");
      expect(
        aabbOverlap(entity, { width: entity.w, height: entity.h }, attr, {
          width: attr.w,
          height: attr.h,
        }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can disable auto avoidance for the saved state", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeOverlappingState()));

      const disabled = runAgent(["avoid", "off", "--state", state]);
      expect(disabled.status).toBe(0);
      const adjusted = runAgent(["fontsize", "0", "--state", state]);

      expect(adjusted.status).toBe(0);
      const next = readState(state);
      const boxes = exportedBoxes(state);
      expect(next.settings.autoAvoid).toBe(false);
      const entity = boxById(boxes, "entity-users");
      const attr = boxById(boxes, "attr-users-name");
      expect(
        aabbOverlap(entity, { width: entity.w, height: entity.h }, attr, {
          width: attr.w,
          height: attr.h,
        }),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can disable auto avoidance at generate time", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");

      const generated = runAgent([
        "generate",
        "--text",
        schema,
        "--auto-avoid",
        "false",
        "--state",
        state,
      ]);

      expect(generated.status).toBe(0);
      expect(readState(state).settings.autoAvoid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves an attribute connector away from relationship-line crossings", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeAttributeConnectorCrossingState()));

      const before = readState(state);
      expect(
        segmentsIntersect(
          nodePosition(before, "entity-users"),
          nodePosition(before, "attr-users-name"),
          nodePosition(before, "entity-orders"),
          nodePosition(before, "rel-orders-users"),
        ),
      ).toBe(true);

      const adjusted = runAgent(["fontsize", "0", "--state", state]);

      expect(adjusted.status).toBe(0);
      const next = readState(state);
      expect(next.settings.autoAvoid).toBe(true);
      expect(nodePosition(next, "entity-users")).toEqual({ x: 0, y: 0 });
      expect(
        segmentsIntersect(
          nodePosition(next, "entity-users"),
          nodePosition(next, "attr-users-name"),
          nodePosition(next, "entity-orders"),
          nodePosition(next, "rel-orders-users"),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI describe", () => {
  it("reports abstract planarity separately from current edge crossings", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makePlanarCrossingState()));

      const text = runAgent(["describe", "--state", state]);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain("crossing: a_b");
      expect(text.stdout).toContain("planarity: planar skeleton");

      const json = runAgent(["describe", "--state", state, "--json"]);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as {
        diagnostics: {
          crossings: number;
          planarity: { planar: boolean; status: string; vertices: number; edges: number };
        };
      };
      expect(parsed.diagnostics.crossings).toBeGreaterThan(0);
      expect(parsed.diagnostics.planarity).toMatchObject({
        planar: true,
        status: "planar",
        vertices: 4,
        edges: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands attribute diagnostics only with --details", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeAttributeDetailState()));

      const brief = runAgent(["describe", "--state", state]);
      expect(brief.status).toBe(0);
      expect(brief.stdout).toContain("attribute overlaps: 1");
      expect(brief.stdout).toContain("attribute-line crossings: 1");
      expect(brief.stdout).not.toContain("attribute overlap: attr-users-email");
      expect(brief.stdout).not.toContain("attribute-line crossing: edge-users-name");

      const detailed = runAgent(["describe", "--state", state, "--details"]);
      expect(detailed.status).toBe(0);
      expect(detailed.stdout).toContain(
        "attribute overlap: attr-users-email email (parent=users) × entity-users users [entity]",
      );
      expect(detailed.stdout).toContain(
        "attribute-line crossing: edge-users-name entity-users users → attr-users-name name × edge-orders-rel entity-orders orders → rel-orders-users placed by",
      );

      const json = runAgent(["describe", "--state", state, "--json", "--details"]);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as {
        diagnostics: {
          details: {
            attributeOverlaps: Array<{ a: { id: string }; b: { id: string } }>;
            attributeLineCrossings: Array<{
              kind: string;
              a?: { edgeId: string };
              b?: { edgeId: string };
            }>;
          };
        };
      };
      expect(parsed.diagnostics.details.attributeOverlaps[0]).toMatchObject({
        a: { id: "attr-users-email" },
        b: { id: "entity-users" },
      });
      expect(parsed.diagnostics.details.attributeLineCrossings[0]).toMatchObject({
        kind: "edge-crossing",
        a: { edgeId: "edge-users-name" },
        b: { edgeId: "edge-orders-rel" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an attribute connector piercing another attribute with --details", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeAttributeLinePiercesAttributeState()));

      const detailed = runAgent(["describe", "--state", state, "--details"]);
      expect(detailed.status).toBe(0);
      expect(detailed.stdout).toContain("attribute-line crossings: 1");
      expect(detailed.stdout).toContain(
        "attribute-line crossing: edge-users-name entity-users users → attr-users-name name pierces attr-users-email email (parent=users)",
      );

      const json = runAgent(["describe", "--state", state, "--json", "--details"]);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as {
        diagnostics: {
          attrCrossings: number;
          details: {
            attributeLineCrossings: Array<{
              kind: string;
              edge?: { edgeId: string };
              attribute?: { id: string };
            }>;
          };
        };
      };
      expect(parsed.diagnostics.attrCrossings).toBe(1);
      expect(parsed.diagnostics.details.attributeLineCrossings[0]).toMatchObject({
        kind: "line-pierces-attribute",
        edge: { edgeId: "edge-users-name" },
        attribute: { id: "attr-users-email" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-planar abstract skeleton when the entity graph contains K3,3", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeK33State()));

      const text = runAgent(["describe", "--state", state]);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain("planarity: non-planar skeleton");
      expect(text.stdout).toContain("some relationship crossings are unavoidable");

      const json = runAgent(["describe", "--state", state, "--json"]);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as {
        diagnostics: { planarity: { planar: boolean; status: string; reason: string } };
      };
      expect(parsed.diagnostics.planarity.planar).toBe(false);
      expect(parsed.diagnostics.planarity.status).toBe("non-planar");
      expect(parsed.diagnostics.planarity.reason).toContain("bipartite planar edge bound");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("focuses by exact entity id instead of label", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
            autoAvoid: false,
          },
          nodes: [
            {
              id: "entity-a",
              type: "entity",
              label: "Account",
              nodeType: "entity",
              x: 100,
              y: 100,
            },
          ],
          edges: [],
        } satisfies AgentState),
      );

      const byLabel = runAgent(["describe", "--focus", "Account", "--state", state]);
      expect(byLabel.status).toBe(0);
      expect(byLabel.stdout).toContain('focus: no entity id matching "Account"');
      expect(byLabel.stdout).not.toContain("FOCUS entity-a");

      const byId = runAgent(["describe", "--focus", "entity-a", "--state", state]);
      expect(byId.status).toBe(0);
      expect(byId.stdout).toContain("FOCUS entity-a  Account");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI entity edits", () => {
  it("addresses move targets by exact entity id instead of label", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
            autoAvoid: false,
          },
          nodes: [
            {
              id: "entity-a",
              type: "entity",
              label: "Account",
              nodeType: "entity",
              x: 100,
              y: 100,
            },
            {
              id: "entity-b",
              type: "entity",
              label: "Billing",
              nodeType: "entity",
              x: 300,
              y: 100,
            },
          ],
          edges: [],
        } satisfies AgentState),
      );

      const byLabel = runAgent(["move", "Account", "160", "180", "--raw", "--state", state]);
      expect(byLabel.status).not.toBe(0);
      expect(byLabel.stderr).toContain("Use an exact id from describe");
      expect(nodePosition(readState(state), "entity-a")).toEqual({ x: 100, y: 100 });

      const byId = runAgent(["move", "entity-a", "160", "180", "--raw", "--state", state]);

      expect(byId.status).toBe(0);
      expect(nodePosition(readState(state), "entity-a")).toEqual({ x: 160, y: 180 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves and nudges exact non-entity node ids", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: false,
            fontScale: 1,
            attrMode: "auto",
            autoAvoid: false,
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
            {
              id: "attr-a-name",
              type: "attribute",
              label: "name",
              nodeType: "attribute",
              parentEntity: "entity-a",
              x: 100,
              y: 170,
            },
            {
              id: "rel-a-b",
              type: "relationship",
              label: "a_b",
              nodeType: "relationship",
              x: 220,
              y: 100,
            },
          ],
          edges: [],
        } satisfies AgentState),
      );

      const movedAttr = runAgent(["move", "attr-a-name", "140", "190", "--raw", "--state", state]);
      expect(movedAttr.status).toBe(0);
      expect(nodePosition(readState(state), "attr-a-name")).toEqual({ x: 140, y: 190 });

      const nudgedRel = runAgent(["nudge", "rel-a-b", "15", "-20", "--raw", "--state", state]);
      expect(nudgedRel.status).toBe(0);
      expect(nodePosition(readState(state), "rel-a-b")).toEqual({ x: 235, y: 80 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and leaves positions unchanged when swapping an attribute id", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: false,
            fontScale: 1,
            attrMode: "auto",
            autoAvoid: false,
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
            {
              id: "attr-a-name",
              type: "attribute",
              label: "name",
              nodeType: "attribute",
              parentEntity: "entity-a",
              x: 100,
              y: 170,
            },
          ],
          edges: [],
        } satisfies AgentState),
      );

      const swapped = runAgent(["swap", "entity-a", "attr-a-name", "--raw", "--state", state]);

      expect(swapped.status).toBe(0);
      expect(swapped.stdout).toContain("warning:");
      expect(swapped.stdout).toContain("swap only supports entity rectangles");
      const next = readState(state);
      expect(nodePosition(next, "entity-a")).toEqual({ x: 100, y: 100 });
      expect(nodePosition(next, "attr-a-name")).toEqual({ x: 100, y: 170 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and leaves positions unchanged when swapping a relationship id", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
            autoAvoid: false,
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
            {
              id: "rel-a-b",
              type: "relationship",
              label: "a_b",
              nodeType: "relationship",
              x: 220,
              y: 100,
            },
          ],
          edges: [],
        } satisfies AgentState),
      );

      const swapped = runAgent(["swap", "entity-a", "rel-a-b", "--raw", "--state", state]);

      expect(swapped.status).toBe(0);
      expect(swapped.stdout).toContain("warning:");
      expect(swapped.stdout).toContain("swap only supports entity rectangles");
      const next = readState(state);
      expect(nodePosition(next, "entity-a")).toEqual({ x: 100, y: 100 });
      expect(nodePosition(next, "rel-a-b")).toEqual({ x: 220, y: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps related relationship diamonds on the line between moved and fixed entities in raw moves", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
            { id: "entity-b", type: "entity", label: "b", nodeType: "entity", x: 300, y: 100 },
            {
              id: "rel-a-b",
              type: "relationship",
              label: "a_b",
              nodeType: "relationship",
              x: 200,
              y: 100,
            },
          ],
          edges: [
            {
              id: "edge-a-rel",
              source: "entity-a",
              target: "rel-a-b",
              edgeType: "entity-relationship",
            },
            {
              id: "edge-rel-b",
              source: "rel-a-b",
              target: "entity-b",
              edgeType: "relationship-entity",
            },
          ],
        } satisfies AgentState),
      );

      const moved = runAgent(["move", "entity-a", "160", "180", "--raw", "--state", state]);

      expect(moved.status).toBe(0);
      const next = readState(state);
      expectPointOnSegment(
        nodePosition(next, "rel-a-b"),
        nodePosition(next, "entity-a"),
        nodePosition(next, "entity-b"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves single-entity relationship diamonds with the entity in raw moves", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(
        state,
        JSON.stringify({
          version: 1,
          input: "manual",
          format: "sql",
          settings: {
            colored: true,
            comment: false,
            hideAttrs: true,
            fontScale: 1,
            attrMode: "auto",
          },
          nodes: [
            { id: "entity-a", type: "entity", label: "a", nodeType: "entity", x: 100, y: 100 },
            {
              id: "rel-one-edge",
              type: "relationship",
              label: "single",
              nodeType: "relationship",
              x: 150,
              y: 100,
            },
            {
              id: "rel-loop",
              type: "relationship",
              label: "loop",
              nodeType: "relationship",
              x: 100,
              y: 40,
              isSelfLoop: true,
            },
          ],
          edges: [
            {
              id: "edge-a-single",
              source: "entity-a",
              target: "rel-one-edge",
              edgeType: "entity-relationship",
            },
            {
              id: "edge-a-loop",
              source: "entity-a",
              target: "rel-loop",
              edgeType: "entity-relationship",
            },
            {
              id: "edge-loop-a",
              source: "rel-loop",
              target: "entity-a",
              edgeType: "relationship-entity",
            },
          ],
        } satisfies AgentState),
      );

      const moved = runAgent(["move", "entity-a", "180", "160", "--raw", "--state", state]);

      expect(moved.status).toBe(0);
      const next = readState(state);
      expect(nodePosition(next, "rel-one-edge")).toEqual({ x: 230, y: 160 });
      expect(nodePosition(next, "rel-loop")).toEqual({ x: 180, y: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sql2er agent CLI moderate attribute layout", () => {
  it("moves a line-pierced attribute to the nearest clear escape instead of a far ring slot", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "sql2er-agent-"));
    try {
      const state = resolve(dir, "er.json");
      writeFileSync(state, JSON.stringify(makeAttributeRingState(12)));

      const baselineRun = runAgent(["attrs", "moderate", "--state", state]);
      expect(baselineRun.status).toBe(0);
      const baseline = readState(state);
      const before = attrPosition(baseline, "attr-owner-a0");

      baseline.nodes.push(
        {
          id: "entity-line-a",
          type: "entity",
          label: "lineA",
          nodeType: "entity",
          x: before.x,
          y: -45,
        },
        {
          id: "rel-line",
          type: "relationship",
          label: "line",
          nodeType: "relationship",
          x: before.x,
          y: 45,
        },
      );
      baseline.edges.push({
        id: "edge-line-a-rel",
        source: "entity-line-a",
        target: "rel-line",
        edgeType: "entity-relationship",
      });
      baseline.settings.attrMode = "auto";
      writeFileSync(state, JSON.stringify(baseline));

      const adjustedRun = runAgent(["attrs", "moderate", "--state", state]);
      expect(adjustedRun.status).toBe(0);
      const adjusted = readState(state);
      const after = attrPosition(adjusted, "attr-owner-a0");

      expect(distance(before, after)).toBeLessThan(80);
      expect(Math.abs(after.y - before.y)).toBeLessThan(50);

      const described = runAgent(["describe", "--state", state, "--json"]);
      expect(described.status).toBe(0);
      const diagnostics = JSON.parse(described.stdout) as {
        diagnostics: { attrCrossings: number; attrOverlaps: number };
      };
      expect(diagnostics.diagnostics.attrCrossings).toBe(0);
      expect(diagnostics.diagnostics.attrOverlaps).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
