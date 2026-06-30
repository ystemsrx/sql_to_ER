import { createRoot } from "react-dom/client";
import "../assets/base.css";
import "../css/style.css";
import EmbeddedApp from "./EmbeddedApp";
import type { EmbeddedGraphState, EmbeddedHtmlConfig } from "./types";

function readEmbeddedState(): EmbeddedGraphState {
  const node = document.getElementById("sql2er-embedded-state");
  if (!node || !node.textContent) {
    throw new Error("Embedded sql2er state was not found.");
  }
  return JSON.parse(node.textContent) as EmbeddedGraphState;
}

function readEmbeddedConfig(): EmbeddedHtmlConfig {
  const node = document.getElementById("sql2er-embedded-config");
  if (!node || !node.textContent) {
    throw new Error("Embedded sql2er config was not found.");
  }
  const config = JSON.parse(node.textContent) as EmbeddedHtmlConfig;
  if (config.lang !== "zh" && config.lang !== "en") {
    throw new Error("Embedded sql2er config lang must be zh or en.");
  }
  return config;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root was not found");
}

document.body.classList.add("embedded-body");
createRoot(rootEl).render(<EmbeddedApp state={readEmbeddedState()} lang={readEmbeddedConfig().lang} />);
