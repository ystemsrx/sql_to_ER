import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("diagnostic overlay animations", () => {
  it("shows parser warnings after an animation frame so fade-in transitions can run", () => {
    const source = readSource("../hooks/useGraph.ts");
    const showParserWarnings = source.match(
      /const showParserWarnings = \(warnings: ParserWarning\[\]\) => \{([\s\S]*?)\n  \};/,
    )?.[1];

    expect(showParserWarnings).toBeTruthy();
    expect(showParserWarnings).toContain("setParserWarningsVisible(false)");
    expect(showParserWarnings).toContain("scheduleParserWarningFadeIn()");
    expect(source).toContain("const scheduleParserWarningFadeIn = () =>");
    expect(source).toContain("requestAnimationFrame");
    expect(showParserWarnings).not.toContain("setParserWarningsVisible(warnings.length > 0)");
  });

  it("keeps embedded parser warnings hidden on first render before scheduling fade-in", () => {
    const source = readSource("../EmbeddedApp.tsx");

    expect(source).toContain(
      "const [parserWarningsVisible, setParserWarningsVisible] = useState(false)",
    );
    expect(source).toContain("showParserWarnings(state.parserWarnings ?? [])");
    expect(source).toContain("parserWarningsShowFrameRef");
  });

  it("renders error overlays with a delayed visible class in app and embedded views", () => {
    const useGraph = readSource("../hooks/useGraph.ts");
    const useEmbeddedGraph = readSource("../hooks/useEmbeddedGraph.ts");
    const app = readSource("../App.tsx");
    const embeddedApp = readSource("../EmbeddedApp.tsx");

    expect(useGraph).toContain("const [errorVisible, setErrorVisible] = useState(false)");
    expect(useEmbeddedGraph).toContain("const [errorVisible, setErrorVisible] = useState(false)");
    expect(app).toContain("errorVisible,");
    expect(app).toContain('diagram-error-overlay${errorVisible ? " is-visible" : ""}');
    expect(embeddedApp).toContain("errorVisible,");
    expect(embeddedApp).toContain('diagram-error-overlay${errorVisible ? " is-visible" : ""}');
  });

  it("defines hidden and visible CSS states for error overlay transitions", () => {
    const css = readSource("../../css/style.css");

    expect(css).toContain(".diagram-error-overlay.is-visible");
    expect(css).toContain("@starting-style");
    expect(css).toContain(".parser-warning-toast.is-visible");
    expect(css).toMatch(/\.diagram-error-overlay\s*\{[\s\S]*opacity:\s*0;/);
    expect(css).toMatch(/\.diagram-error-overlay\.is-visible\s*\{[\s\S]*opacity:\s*1;/);
  });
});
