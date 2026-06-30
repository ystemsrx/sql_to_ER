import "./shims"; // MUST be first: installs rAF so headless layout runs to completion

import { readFileSync, writeFileSync, existsSync, readFileSync as rf } from "node:fs";
import { resolve } from "node:path";
import {
  generate,
  runLayout,
  rotate,
  setFontScale,
  setAttrMode,
  setLabel,
  setLabelMode,
  setLabels,
  resetLabels,
  setAutoAvoid,
  move,
  nudge,
  swap,
  splitComponents,
  DEFAULT_SETTINGS,
  type AttrMode,
  type LabelMode,
  type State,
} from "./ops";
import { parse as parsePath } from "node:path";

const ATTR_MODES = ["auto", "compact", "moderate"] as const;
import { describe, describeJson } from "./describe";
import {
  exportDrawio,
  exportHtml,
  exportJson,
  exportPng,
  exportSvg,
  type EmbeddedHtmlLanguage,
} from "./exporters";
import { createHeadlessGraph } from "./adapter";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
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

const boolFlag = (v: string | boolean | undefined, def = false): boolean => {
  if (v === undefined) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === "yes";
};

const hasFlag = (flags: Record<string, string | boolean>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(flags, name);

function htmlLang(flags: Record<string, string | boolean>): EmbeddedHtmlLanguage {
  if (flags.lang !== "zh" && flags.lang !== "en") {
    throw new Error("export html requires --lang zh|en");
  }
  return flags.lang;
}

function statePath(flags: Record<string, string | boolean>): string {
  const p = typeof flags.state === "string" ? flags.state : "sql2er-state.json";
  return resolve(process.cwd(), p);
}

function loadState(flags: Record<string, string | boolean>): State {
  const p = statePath(flags);
  if (!existsSync(p)) throw new Error(`No state at ${p}. Run \`generate\` first.`);
  return JSON.parse(readFileSync(p, "utf8")) as State;
}

function saveState(flags: Record<string, string | boolean>, state: State): void {
  writeFileSync(statePath(flags), JSON.stringify(state), "utf8");
}

function readInput(flags: Record<string, string | boolean>): string {
  if (typeof flags.input === "string") return rf(resolve(process.cwd(), flags.input), "utf8");
  if (typeof flags.text === "string") return flags.text;
  if (flags.stdin || !process.stdin.isTTY) {
    try {
      return rf(0, "utf8");
    } catch {
      /* no stdin */
    }
  }
  throw new Error("Provide input via --input <file>, --text <inline>, or piped stdin.");
}

function readLabels(flags: Record<string, string | boolean>): Record<string, string> {
  const hasFile = typeof flags.file === "string";
  const hasText = typeof flags.text === "string";
  if (hasFile === hasText)
    throw new Error("labels batch requires exactly one of --file or --text.");
  const raw = hasFile
    ? rf(resolve(process.cwd(), flags.file as string), "utf8")
    : (flags.text as string);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('labels batch expects a JSON object: {"node-id":"label"}.');
  }
  const labels: Record<string, string> = {};
  Object.entries(parsed).forEach(([id, label]) => {
    if (typeof label !== "string") throw new Error(`Label for "${id}" must be a string.`);
    labels[id] = label;
  });
  return labels;
}

function printState(state: State, flags: Record<string, string | boolean>): void {
  const graph = createHeadlessGraph(state.nodes, state.edges);
  process.stdout.write(
    describe(graph, {
      full: boolFlag(flags.full),
      focus: typeof flags.focus === "string" ? flags.focus : undefined,
    }) + "\n",
  );
}

const HELP = `sql2er-agent — headless SQL/DBML → Chen-model ER layout for agents

Usage: node sql2er-agent.mjs <command> [args] [--flags]   (state in ./sql2er-state.json)

  generate                 Parse input, build the ER graph, lay it out.
      --input <file> | --text "<sql>" | (piped stdin)
      --format auto|sql|dbml         (default auto)
      --colored true|false           (default true)
      --comment                      show column/table comments instead of names
      --hide-attrs                   skeleton only — generate NO attributes (tighter,
                                     cleaner layout); decided here, not at export
      --attrs auto|compact|moderate  attribute orbit mode (default auto)
      --auto-avoid true|false    resolve node overlaps after layout/edit (default true)
      --layout optimal|arrange|none  (default optimal)
  describe                 Print skeleton + diagnostics + ASCII map.
      --full                         also list attributes
      --focus <id>                   zoom into one entity
      --json                         machine-readable scene
  layout <optimal|arrange>  Re-run a layout. optimal = stress-spaced skeleton
                           (rooms for attribute rings; the recommended default);
                           arrange = settle current positions.
  move <id> <x> <y>        Place a node. Entity attributes and diamonds follow. Then settles
                           with one arrange pass unless --raw.
  nudge <id> <dx> <dy>     Shift a node by a delta. --raw to skip the settle pass.
  swap <idA> <idB>         Exchange two entities' positions. --raw to skip settle.
  rotate <degrees>         Rotate the whole diagram about its centre (shapes stay upright).
  attrs <auto|compact|moderate>  Re-place attribute ellipses. compact = tightest
                           non-overlapping pack; moderate = uniform even ring. Persists.
  labels set <id> <label> Set a manual node label.
  labels batch --file labels.json | --text '{"id":"label"}'
                           Set many manual labels at once.
  labels reset <id|all>    Clear manual labels and restore the active name/comment mode.
  labels mode <name|comment>
                           Switch generated labels without clearing manual labels.
  fontsize <delta>         0 = default; negative = smaller, positive = larger (≈±0.1/step).
  avoid <on|off>           Toggle automatic node overlap avoidance for this state.
  export <drawio|svg|png|json|html> Write output. --out <file> (else stdout).
      html requires --lang zh|en
      --split                        one diagram per disconnected component
                                     (--out base.ext -> base-<name>.ext per component)
  help
`;

function main(): void {
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
        format: (typeof flags.format === "string" ? flags.format : "auto") as
          "auto" | "sql" | "dbml",
        layout: (typeof flags.layout === "string" ? flags.layout : "optimal") as
          "optimal" | "arrange" | "none",
        settings: {
          ...DEFAULT_SETTINGS,
          colored: boolFlag(flags.colored, true),
          comment: boolFlag(flags.comment),
          hideAttrs: boolFlag(flags["hide-attrs"]),
          attrMode: ATTR_MODES.includes(flags.attrs as AttrMode)
            ? (flags.attrs as AttrMode)
            : "auto",
          autoAvoid: boolFlag(flags["auto-avoid"], true),
        },
      });
      saveState(flags, state);
      printState(state, flags);
      break;
    }
    case "attrs": {
      const mode = _[1] as AttrMode;
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
        if (!id || label === undefined) throw new Error("labels set <id> <label>");
        const { state, resolved } = setLabel(loadState(flags), id, label);
        saveState(flags, state);
        process.stdout.write(`labeled ${resolved.map((r) => `${r.id}="${r.label}"`).join(", ")}\n`);
        printState(state, flags);
        break;
      }
      if (sub === "batch") {
        const { state, resolved } = setLabels(loadState(flags), readLabels(flags));
        saveState(flags, state);
        process.stdout.write(`labeled ${resolved.length} nodes\n`);
        printState(state, flags);
        break;
      }
      if (sub === "reset") {
        const idOrAll = _[2];
        if (!idOrAll) throw new Error("labels reset <id|all>");
        const { state, resolved } = resetLabels(loadState(flags), idOrAll);
        saveState(flags, state);
        process.stdout.write(`reset ${resolved.length} labels\n`);
        printState(state, flags);
        break;
      }
      if (sub === "mode") {
        const mode = _[2] as LabelMode;
        if (mode !== "name" && mode !== "comment") throw new Error("labels mode <name|comment>");
        const { state } = setLabelMode(loadState(flags), mode);
        saveState(flags, state);
        process.stdout.write(`labelMode=${mode}\n`);
        printState(state, flags);
        break;
      }
      throw new Error(
        "labels set <id> <label> | labels batch --file <json> | labels batch --text <json> | labels reset <id|all> | labels mode <name|comment>",
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
      if (!id || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("move <id> <x> <y>");
      const { state, resolved } = move(loadState(flags), id, x, y, boolFlag(flags.raw));
      saveState(flags, state);
      process.stdout.write(`moved ${resolved.map((r) => r.label).join(", ")}\n`);
      printState(state, flags);
      break;
    }
    case "nudge": {
      const id = _[1];
      const dx = Number(_[2]);
      const dy = Number(_[3]);
      if (!id || !Number.isFinite(dx) || !Number.isFinite(dy))
        throw new Error("nudge <id> <dx> <dy>");
      const { state, resolved } = nudge(loadState(flags), id, dx, dy, boolFlag(flags.raw));
      saveState(flags, state);
      process.stdout.write(`nudged ${resolved.map((r) => r.label).join(", ")}\n`);
      printState(state, flags);
      break;
    }
    case "swap": {
      const a = _[1];
      const b = _[2];
      if (!a || !b) throw new Error("swap <idA> <idB>");
      const { state, resolved, warnings } = swap(loadState(flags), a, b, boolFlag(flags.raw));
      saveState(flags, state);
      if (warnings?.length) {
        warnings.forEach((warning) => process.stdout.write(`warning: ${warning}\n`));
      } else {
        process.stdout.write(`swapped ${resolved.map((r) => r.label).join(" ↔ ")}\n`);
      }
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
      process.stdout.write(`fontScale=${next.settings.fontScale.toFixed(2)}\n`);
      printState(next, flags);
      break;
    }
    case "avoid": {
      const mode = _[1];
      if (mode !== "on" && mode !== "off") throw new Error("avoid <on|off>");
      const next = setAutoAvoid(loadState(flags), mode === "on");
      saveState(flags, next);
      process.stdout.write(`autoAvoid=${next.settings.autoAvoid ? "on" : "off"}\n`);
      printState(next, flags);
      break;
    }
    case "export": {
      if (hasFlag(flags, "hide-attrs")) {
        throw new Error(
          "--hide-attrs is only valid on generate; export writes whatever the saved state contains.",
        );
      }
      const fmt = _[1];
      const state = loadState(flags);
      const render = (s: State): { out: string | Buffer; ext: string } => {
        if (fmt === "drawio") return { out: exportDrawio(s), ext: "drawio" };
        if (fmt === "svg") return { out: exportSvg(s), ext: "svg" };
        if (fmt === "png") return { out: exportPng(s), ext: "png" };
        if (fmt === "json") return { out: exportJson(s), ext: "json" };
        if (fmt === "html") return { out: exportHtml(s, htmlLang(flags)), ext: "html" };
        throw new Error("export <drawio|svg|png|json|html>");
      };
      const writeExport = (file: string, out: string | Buffer, ext: string): void => {
        writeFileSync(
          resolve(process.cwd(), file),
          out,
          typeof out === "string" ? "utf8" : undefined,
        );
        const bytes = typeof out === "string" ? Buffer.byteLength(out) : out.length;
        process.stdout.write(`wrote ${file} (${ext}, ${bytes} bytes)\n`);
      };

      // --split: one diagram per disconnected component (unrelated tables/clusters)
      if (boolFlag(flags.split)) {
        const comps = splitComponents(state);
        if (comps.length <= 1) {
          process.stdout.write(`only 1 component — nothing to split; exporting whole diagram\n`);
        } else if (fmt === "png" && typeof flags.out !== "string") {
          throw new Error("export png --split requires --out because PNG output is binary.");
        } else if (typeof flags.out === "string") {
          const p = parsePath(flags.out);
          comps.forEach((c) => {
            const { out, ext } = render(c.state);
            const file = `${p.dir ? p.dir + "/" : ""}${p.name}-${c.name}.${ext}`;
            writeExport(file, out, ext);
          });
          break;
        } else {
          comps.forEach((c) => {
            const { out } = render(c.state);
            process.stdout.write(`=== component: ${c.name} ===\n${out}\n`);
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
