import { mkdtempSync, rmSync } from "node:fs";
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
