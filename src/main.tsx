import React from "react";
import { createRoot } from "react-dom/client";
import "../assets/fonts/fonts.css";
import "../assets/base.css";
import "../vendor/fontawesome/css/all.min.css";
import "../css/style.css";
import App from "./App";
import { setupLanguageSwitch } from "./language";

setupLanguageSwitch();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root was not found");
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
