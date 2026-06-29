import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  }>;
  edges: Array<{ id: string; source: string; target: string; edgeType: string; label?: string }>;
};

function readState(path: string): AgentState {
  return JSON.parse(readFileSync(path, "utf8")) as AgentState;
}

function attrPosition(state: AgentState, id: string): { x: number; y: number } {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return { x: node.x, y: node.y };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nodePosition(state: AgentState, id: string): { x: number; y: number } {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return { x: node.x, y: node.y };
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

describe("sql2er agent CLI attribute visibility", () => {
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

describe("sql2er agent CLI entity edits", () => {
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
