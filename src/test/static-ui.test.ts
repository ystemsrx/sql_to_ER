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
