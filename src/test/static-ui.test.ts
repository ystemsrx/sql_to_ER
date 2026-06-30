import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("static landing page content", () => {
  it("puts the agent skill install item first and removes the old third feature", () => {
    const html = read("index.html");
    const features = html.slice(
      html.indexOf('<section id="features">'),
      html.indexOf("<!-- DEMO -->"),
    );

    expect(features).toContain("npx skills add ystemsrx/sql_to_er");
    expect(features).not.toContain("拖拽与双击编辑");
    expect(features.indexOf('<div class="feat-num">01</div>')).toBeLessThan(
      features.indexOf('<div class="feat-num">02</div>'),
    );
  });

  it("mentions the agent skill alternative after the five-step heading", () => {
    const html = read("index.html");
    const how = html.slice(html.indexOf('<section id="how">'), html.indexOf("<!-- CHEN -->"));

    expect(how).toContain("或者安装 Agent Skill");
    expect(html).toContain("or install the Agent Skill");
  });

  it("adds an FAQ entry for the agent skill", () => {
    const html = read("index.html");
    const faq = html.slice(html.indexOf('<section id="faq">'), html.indexOf("<!-- CTA -->"));

    expect(faq).toContain("Agent Skill 是什么");
    expect(faq).toContain("npx skills add ystemsrx/sql_to_er");
    expect(html).toContain("What is the Agent Skill");
  });
});

describe("generator install command pill", () => {
  it("removes the generator eyebrow line and keeps whitespace above the title", () => {
    const html = read("sql2er.html");
    const css = read("css/style.css");
    const i18n = read("src/i18n.ts");

    expect(html).not.toContain("Chen Model · Entity-Relationship");
    expect(html).not.toContain("header-eyebrow");
    expect(i18n).not.toContain("Chen Model · Entity-Relationship");
    expect(css).toContain("padding-top: 36px");
  });

  it("renders the install command and copy affordance in the generator header", () => {
    const app = read("src/App.tsx");
    const css = read("css/style.css");

    expect(app).toContain('const SKILL_INSTALL_COMMAND = "npx skills add ystemsrx/sql_to_er";');
    expect(app).toContain('className="skill-install-pill"');
    expect(app).toContain("navigator.clipboard.writeText(SKILL_INSTALL_COMMAND)");
    expect(css).toContain(".skill-install-pill");
    expect(css).toContain(".skill-install-copy");
  });

  it("keeps the generator command pill at page top without fixed positioning or a tinted side block", () => {
    const css = read("css/style.css");
    const pillRule = css.match(/\.skill-install-pill\s*{[^}]+}/)?.[0] ?? "";
    const capRule = css.match(/\.skill-install-copy-cap\s*{[^}]+}/)?.[0] ?? "";
    const copyRule = css.match(/\.skill-install-copy\s*{[^}]+}/)?.[0] ?? "";
    const activeRule = css.match(/\.skill-install-copy:active\s*{[^}]+}/)?.[0] ?? "";

    expect(pillRule).not.toContain("position: fixed");
    expect(pillRule).toContain("top: clamp(14px, 1.8vw, 24px)");
    expect(capRule).not.toContain("background:");
    expect(capRule).toContain("width: 42px");
    expect(copyRule).toContain("width: 34px");
    expect(copyRule).toContain("height: 34px");
    expect(activeRule).toContain("translateY(1px)");
  });
});

describe("generator auto avoidance control", () => {
  it("renders an opt-in auto avoidance icon button above the font slider", () => {
    const app = read("src/App.tsx");
    const icons = read("src/components/icons.tsx");
    const css = read("css/style.css");
    const i18n = read("src/i18n.ts");

    expect(app).toContain("autoAvoid");
    expect(app).toContain('className={`avoid-toggle ${autoAvoid ? "active" : ""}`}');
    expect(app).toContain("<ArrowsUpDownLeftRightIcon />");
    expect(icons).toContain("export const ArrowsUpDownLeftRightIcon = makeIcon");
    expect(i18n).toContain("开启自动避让");
    expect(i18n).toContain("Enable auto avoidance");

    const avoidMobileRule =
      css.match(/@media \(max-width: 768px\)[\s\S]*?\n  \.avoid-toggle\s*{[^}]+}/)?.[0] ?? "";
    expect(css).toContain(".avoid-toggle {\n  top: 256px;");
    expect(css).toContain(
      ".font-size-slider {\n  position: absolute;\n  left: 16px;\n  top: 312px;",
    );
    expect(avoidMobileRule).toContain("bottom: 64px");
  });

  it("keeps embedded mobile canvas controls on the left", () => {
    const css = read("css/style.css");

    const embeddedMobileBlock =
      css.match(/@media \(max-width: 768px\)[\s\S]*?\.skill-install-pill\s*{/)?.[0] ?? "";

    expect(embeddedMobileBlock).toContain(".embedded-mode .background-toggle");
    expect(embeddedMobileBlock).toContain(".embedded-mode .colorize-toggle");
    expect(embeddedMobileBlock).toContain(".embedded-mode .attrs-toggle");
    expect(embeddedMobileBlock).toContain(".embedded-mode .force-toggle");
    expect(embeddedMobileBlock).toContain(".embedded-mode .avoid-toggle");
    expect(embeddedMobileBlock).toContain("left: 16px");
    expect(embeddedMobileBlock).toContain("right: auto");
    expect(embeddedMobileBlock).toContain("top: 208px");
    expect(embeddedMobileBlock).toContain("bottom: auto");
  });

  it("keeps the embedded preview legend consistent with the web preview legend", () => {
    const app = read("src/App.tsx");
    const embeddedApp = read("src/EmbeddedApp.tsx");

    expect(app).toContain("t.legendPk");
    expect(embeddedApp).toContain("t.legendPk");
  });

  it("keeps embedded preview unframed while preserving rounded editable surfaces", () => {
    const css = read("css/style.css");
    const previewCardRule =
      css.match(/\.embedded-mode \.output-section \.card\s*{[^}]+}/)?.[0] ?? "";
    const embeddedCmRule = css.match(/\.embedded-input-content \.cm-host\s*{[^}]+}/)?.[0] ?? "";
    const diagramContentRule =
      css.match(/\.embedded-mode \.embedded-diagram-content\s*{[^}]+}/)?.[0] ?? "";
    const diagramRule = css.match(/\.embedded-mode \.diagram-container\s*{[^}]+}/)?.[0] ?? "";

    expect(previewCardRule).toContain("border: 0");
    expect(previewCardRule).toContain("box-shadow: none");
    expect(embeddedCmRule).toContain("border-radius: var(--radius-md)");
    expect(diagramContentRule).toContain("padding: 0");
    expect(diagramContentRule).toContain("gap: 0");
    expect(diagramRule).toContain("border-radius: 0 0 var(--radius-xl) var(--radius-xl)");
  });

  it("uses a longer editor and a flatter full-row export button in embedded mode", () => {
    const app = read("src/App.tsx");
    const css = read("css/style.css");
    const embeddedExportRowRule = css.match(/\.embedded-export-row\s*{[^}]+}/)?.[0] ?? "";
    const embeddedExportButtonRule =
      css.match(
        /\.embedded-export-wrap \.export-btn,[\s\S]*?\.embedded-export-wrap \.export-btn\[data-state="success"\]\s*{[^}]+}/,
      )?.[0] ?? "";

    expect(app).toContain('height: "540px"');
    expect(css).toContain(".cm-host {\n  height: 540px;");
    expect(embeddedExportRowRule).toContain("padding: 14px 0 8px");
    expect(embeddedExportButtonRule).toContain("height: 46px");
    expect(embeddedExportButtonRule).toContain("width: 100%");
  });

  it("documents the recommended manual fine-tuning sequence for exported HTML", () => {
    const skill = read("skills/sql2er/SKILL.md");

    expect(skill).toContain("manual fine-tuning");
    expect(skill).toContain("open the HTML");
    expect(skill).toContain("enable continuous force layout");
    expect(skill).toContain("enable automatic avoidance");
    expect(skill).toContain("double-click nodes");
    expect(skill).toContain("hand-tune");
  });

  it("documents planarity in describe diagnostics", () => {
    const commands = read("skills/sql2er/references/commands.md");

    expect(commands).toContain("planarity:");
    expect(commands).toContain("abstract entity-relationship skeleton");
  });

  it("keeps web auto avoidance off by default", () => {
    const hook = read("src/hooks/useGraph.ts");

    expect(hook).toContain("const [autoAvoid, setAutoAvoidState] = useState(false)");
  });

  it("keeps embedded auto avoidance off on first load even when the agent state enabled it", () => {
    const hook = read("src/hooks/useEmbeddedGraph.ts");

    expect(hook).toContain("const [autoAvoid, setAutoAvoidState] = useState(false)");
    expect(hook).toContain("const autoAvoidRef = useRef(false)");
    expect(hook).not.toContain("setAutoAvoidState(nextSettings.autoAvoid === true)");
  });

  it("does not run full auto avoidance synchronously on each font slider move", () => {
    const embeddedHook = read("src/hooks/useEmbeddedGraph.ts");
    const webHook = read("src/hooks/useGraph.ts");
    const embeddedFontScaleBody =
      embeddedHook.match(
        /const setFontScale = \(next: number\) => \{([\s\S]*?)\n  \};\n\n  const setForceOn/,
      )?.[1] ?? "";
    const webFontScaleBody =
      webHook.match(
        /const setFontScale = \(next: number\) => \{([\s\S]*?)\n  \};\n\n  const setForceOn/,
      )?.[1] ?? "";

    expect(embeddedHook).toContain("scheduleFontScaleAutoAvoid");
    expect(webHook).toContain("scheduleFontScaleAutoAvoid");
    expect(embeddedFontScaleBody).not.toContain("historyRef.current.record");
    expect(embeddedFontScaleBody).not.toContain("handleAfterGraphChange()");
    expect(webFontScaleBody).not.toContain("persistAfterOptionalAutoAvoid(700)");
  });

  it("runs one auto avoidance pass when continuous force layout is turned off", () => {
    const webHook = read("src/hooks/useGraph.ts");
    const setForceOnBody =
      webHook.match(
        /const setForceOn = \(next: boolean\) => \{([\s\S]*?)\n  \};\n\n  const setAutoAvoid/,
      )?.[1] ?? "";

    expect(setForceOnBody).toContain("const wasOn = forceOnRef.current");
    expect(setForceOnBody).toContain("wasOn && !next");
    expect(setForceOnBody).toContain("persistAfterOptionalAutoAvoid");
  });

  it("waits one animation frame before auto avoiding after continuous force turns off", () => {
    const webHook = read("src/hooks/useGraph.ts");
    const embeddedHook = read("src/hooks/useEmbeddedGraph.ts");

    expect(webHook).toContain("requestAnimationFrame(() => {\n        persistAfterOptionalAutoAvoid");
    expect(embeddedHook).toContain("requestAnimationFrame(() => {\n        handleAfterGraphChange");
  });

  it("does not rebuild all edge segments for every auto-avoid candidate point", () => {
    const autoAvoid = read("src/graph/autoAvoid.ts");

    expect(autoAvoid).toContain("edgeSegments: EdgeSegment[]");
    expect(autoAvoid).toContain("const edgeSegments = currentEdges();");
    expect(autoAvoid).not.toContain(
      "const edgeSegments = currentEdges();\n\n    for (const other of nodes)",
    );
  });
});
