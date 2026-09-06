import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

let directory: string;
const agent = resolve("skills/sql2er/scripts/sql2er-agent.mjs");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [agent, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
  });
beforeEach(() => {
  directory = mkdtempSync(resolve(tmpdir(), "sql2er-boundaries-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const baseState = () => ({
  version: 1,
  input: "CREATE TABLE users(id INT);",
  format: "sql",
  settings: {
    colored: true,
    comment: false,
    hideAttrs: false,
    fontScale: 1,
    attrMode: "auto",
    autoAvoid: true,
  },
  nodes: [{ id: "users", nodeType: "entity", type: "entity", label: "users", x: 100, y: 100 }],
  edges: [],
});
const save = (state: unknown) =>
  writeFileSync(resolve(directory, "sql2er-state.json"), JSON.stringify(state));

it.each([
  ["fill", 'invalid"color'],
  ["stroke", "url(https://example.invalid/paint)"],
  ["lineWidth", "2;invalid"],
])("rejects untrusted shape %s before creating any export", (key, value) => {
  const state = baseState();
  Object.assign(state.nodes[0], { style: { [key]: value } });
  save(state);
  const original = readFileSync(resolve(directory, "sql2er-state.json"), "utf8");
  const result = run("export", "svg", "--out", "out.svg");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Invalid state");
  expect(existsSync(resolve(directory, "out.svg"))).toBe(false);
  expect(readFileSync(resolve(directory, "sql2er-state.json"), "utf8")).toBe(original);
});

it.each(["fill", "fontSize", "fontWeight", "fontFamily"])("rejects invalid label %s", (key) => {
  const state = baseState();
  Object.assign(state.nodes[0], { labelCfg: { style: { [key]: '<invalid attr="x">' } } });
  save(state);
  expect(run("export", "svg").status).toBe(1);
});

it("exports text literally and drops arbitrary renderer options from embedded state", () => {
  const state = baseState();
  state.nodes[0].label = '<b title="literal">A & B</b>';
  Object.assign(state.nodes[0], { img: "https://example.invalid/image", unknownOption: true });
  save(state);
  const svg = run("export", "svg");
  expect(svg.status).toBe(0);
  expect(svg.stdout).toContain("&lt;b title=&quot;literal&quot;&gt;A &amp; B&lt;/b&gt;");
  expect(svg.stdout).not.toContain("<b ");
  const html = run("export", "html", "--lang", "en");
  expect(html.status).toBe(0);
  const embedded = JSON.parse(
    html.stdout.match(/id="sql2er-embedded-state">([\s\S]*?)<\/script>/)![1],
  );
  expect(embedded.nodes[0].img).toBeUndefined();
  expect(embedded.nodes[0].unknownOption).toBeUndefined();
  expect(embedded.nodes[0].label).toBe(state.nodes[0].label);
});

it.each([1e100, Infinity, NaN, "100", null])("rejects invalid coordinates from JSON (%s)", (x) => {
  const state = baseState();
  Object.assign(state.nodes[0], { x });
  save(state);
  const result = run("layout", "arrange");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Invalid state");
});

it.each(["move", "nudge"])("rejects out-of-range %s without modifying the state", (command) => {
  save(baseState());
  const original = readFileSync(resolve(directory, "sql2er-state.json"), "utf8");
  const result = run(command, "users", "1e100", "0");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(readFileSync(resolve(directory, "sql2er-state.json"), "utf8")).toBe(original);
});

it("validates IDs, endpoints, versions and settings", () => {
  for (const mutate of [
    (s: ReturnType<typeof baseState>) => {
      s.version = 2;
    },
    (s: ReturnType<typeof baseState>) => {
      s.nodes.push({ ...s.nodes[0] });
    },
    (s: ReturnType<typeof baseState>) => {
      Object.assign(s, { edges: [{ source: "users", target: "missing" }] });
    },
    (s: ReturnType<typeof baseState>) => {
      Object.assign(s.settings, { fontScale: "1" });
    },
  ]) {
    const state = baseState();
    mutate(state);
    save(state);
    expect(run("export", "json").status).toBe(1);
  }
});

it("writes all components despite normalized and suffix name collisions", () => {
  const generated = run(
    "generate",
    "--text",
    'CREATE TABLE "a-b"(id INT); CREATE TABLE a_b(id INT); CREATE TABLE a_b_2(id INT);',
    "--layout",
    "none",
    "--auto-avoid",
    "false",
  );
  expect(generated.status).toBe(0);
  expect(run("export", "json", "--split", "--out", "parts.json").status).toBe(0);
  const files = readdirSync(directory).filter(
    (name) => name.startsWith("parts-") && name.endsWith(".json"),
  );
  expect(files).toHaveLength(3);
  const names = files.flatMap((file) =>
    JSON.parse(readFileSync(resolve(directory, file), "utf8"))
      .nodes.filter((n: { type: string }) => n.type === "entity")
      .map((n: { label: string }) => n.label),
  );
  expect(new Set(names)).toEqual(new Set(["a-b", "a_b", "a_b_2"]));
});

it("omits unrelated SQL and diagnostics from split HTML", () => {
  expect(
    run(
      "generate",
      "--text",
      "CREATE TABLE public_part(id INT); CREATE TABLE private_part(secret INT); -- private-only-comment\nCREATE VIEW private_view AS SELECT 1;",
      "--layout",
      "none",
      "--auto-avoid",
      "false",
    ).status,
  ).toBe(0);
  expect(run("export", "html", "--lang", "en", "--split", "--out", "part.html").status).toBe(0);
  const html = readFileSync(resolve(directory, "part-public_part.html"), "utf8");
  const state = JSON.parse(html.match(/id="sql2er-embedded-state">([\s\S]*?)<\/script>/)![1]);
  expect(state.input).toBe("");
  expect(state.parserWarnings).toBeUndefined();
  expect(html).not.toContain("private_part");
  expect(html).not.toContain("private-only-comment");
  expect(
    state.nodes
      .filter((n: { nodeType: string }) => n.nodeType === "entity")
      .map((n: { label: string }) => n.label),
  ).toEqual(["public_part"]);
});

it("omits source for a single-component split while normal HTML retains it", () => {
  save(baseState());
  expect(run("export", "html", "--lang", "en", "--split", "--out", "single.html").status).toBe(0);
  expect(run("export", "html", "--lang", "en", "--out", "whole.html").status).toBe(0);
  const embedded = (name: string) =>
    JSON.parse(
      readFileSync(resolve(directory, name), "utf8").match(
        /id="sql2er-embedded-state">([\s\S]*?)<\/script>/,
      )![1],
    );
  expect(embedded("single.html").input).toBe("");
  expect(embedded("whole.html").input).toBe(baseState().input);
});
