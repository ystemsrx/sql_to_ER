import { I18N, type Language } from "./i18n";

export function detectLang(): Language {
  const saved = localStorage.getItem("sql2er-lang");
  if (saved === "zh" || saved === "en") return saved;
  const list =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en"];
  return list.some((l) => (l || "").toLowerCase().startsWith("zh"))
    ? "zh"
    : "en";
}

export function setupLanguageSwitch(initialLang = detectLang()) {
  const root = document.documentElement;
  const switcher = document.querySelector<HTMLElement>(".lang-switch");
  if (!switcher) return initialLang;
  const options = switcher.querySelectorAll<HTMLButtonElement>(".lang-option");
  const headerEls = {
    i18n: document.querySelectorAll<HTMLElement>("[data-i18n]"),
    html: document.querySelectorAll<HTMLElement>("[data-i18n-html]"),
  };

  function applyHeader(lang: Language) {
    const dict = I18N[lang];
    headerEls.i18n.forEach((el) => {
      const k = el.getAttribute("data-i18n") as keyof typeof dict;
      if (dict[k] !== undefined) el.textContent = String(dict[k]);
    });
    headerEls.html.forEach((el) => {
      const k = el.getAttribute("data-i18n-html") as keyof typeof dict;
      if (dict[k] !== undefined) el.innerHTML = String(dict[k]);
    });
    document.title = dict.pageTitle;
    root.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    switcher.setAttribute("data-lang", lang);
    options.forEach((btn) => {
      const active = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function setLang(lang: Language, opts?: { initial?: boolean }) {
    if (opts?.initial) {
      applyHeader(lang);
      window.dispatchEvent(
        new CustomEvent("sql2er-lang", {
          detail: { lang, initial: true },
        }),
      );
      return;
    }
    const current = document.documentElement.getAttribute("lang");
    if (current && (current.startsWith("zh") ? "zh" : "en") === lang) {
      return;
    }
    document.body.classList.add("is-lang-fading");
    localStorage.setItem("sql2er-lang", lang);
    setTimeout(() => {
      applyHeader(lang);
      window.dispatchEvent(new CustomEvent("sql2er-lang", { detail: { lang } }));
      requestAnimationFrame(() => {
        document.body.classList.remove("is-lang-fading");
      });
    }, 200);
  }

  options.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-lang");
      if (next === "zh" || next === "en") setLang(next);
    });
  });

  setLang(initialLang, { initial: true });
  return initialLang;
}
