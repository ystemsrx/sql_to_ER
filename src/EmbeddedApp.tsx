import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import G6 from "@antv/g6";
import { I18N } from "./i18n";
import type { Language } from "./i18n";
import { patchRelationshipLinkPoints, registerCustomNodes } from "./builder";
import { CodeEditor } from "./editor";
import {
  ArrowsUpDownLeftRightIcon,
  CircleNodesIcon,
  EyeIcon,
  EyeSlashIcon,
  ListUlIcon,
  PaletteIcon,
} from "./components/icons";
import * as Exporter from "./exporter";
import type { EmbeddedGraphState } from "./types";
import { useEmbeddedGraph } from "./hooks/useEmbeddedGraph";
import {
  useExportButton,
  type ExportDoneCallback,
  type ExportFormat,
} from "./hooks/useExportButton";
import { useUndoRedoShortcuts } from "./hooks/useUndoRedoShortcuts";
import { useWheelZoomRotate } from "./hooks/useWheelZoomRotate";
import type { ParserWarning } from "./types";

registerCustomNodes(G6);

const FONT_SCALE_MIN = 0.4;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_RANGE = FONT_SCALE_MAX - FONT_SCALE_MIN;
const EMBEDDED_EXPORT_FORMATS: ExportFormat[] = ["PNG", "XML", "SVG", "JSON"];

interface EmbeddedAppProps {
  state: EmbeddedGraphState;
  lang: Language;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadJson(state: EmbeddedGraphState): void {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(blob, "er-state.json");
}

export default function EmbeddedApp({ state, lang }: EmbeddedAppProps) {
  const t = I18N[lang];
  const [showBackground, setShowBackground] = useState(true);
  const [parserWarnings, setParserWarnings] = useState<ParserWarning[]>(state.parserWarnings ?? []);
  const [parserWarningsVisible, setParserWarningsVisible] = useState(false);
  const parserWarningsHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parserWarningsShowFrameRef = useRef<number | null>(null);
  const {
    containerRef,
    graphRef,
    historyRef,
    inputText,
    isColored,
    hideFields,
    fontScale,
    forceOn,
    autoAvoid,
    hasGraph,
    error,
    errorVisible,
    setError,
    setIsColored,
    setHideFields,
    setFontScale,
    setForceOn,
    setAutoAvoid,
    fitView,
    currentState,
  } = useEmbeddedGraph(state);

  const clearParserWarningHideTimer = () => {
    if (parserWarningsHideTimerRef.current !== null) {
      clearTimeout(parserWarningsHideTimerRef.current);
      parserWarningsHideTimerRef.current = null;
    }
  };

  const cancelParserWarningShowFrame = () => {
    if (parserWarningsShowFrameRef.current === null) return;
    cancelAnimationFrame(parserWarningsShowFrameRef.current);
    parserWarningsShowFrameRef.current = null;
  };

  const scheduleParserWarningFadeIn = () => {
    cancelParserWarningShowFrame();
    parserWarningsShowFrameRef.current = requestAnimationFrame(() => {
      parserWarningsShowFrameRef.current = requestAnimationFrame(() => {
        parserWarningsShowFrameRef.current = null;
        setParserWarningsVisible(true);
      });
    });
  };

  const showParserWarnings = (warnings: ParserWarning[]) => {
    clearParserWarningHideTimer();
    cancelParserWarningShowFrame();
    setParserWarningsVisible(false);
    if (warnings.length === 0) {
      setParserWarnings([]);
      return;
    }
    setParserWarnings(warnings);
    scheduleParserWarningFadeIn();
  };

  useEffect(() => {
    showParserWarnings(state.parserWarnings ?? []);
    return () => {
      clearParserWarningHideTimer();
      cancelParserWarningShowFrame();
    };
  }, [state]);

  const dismissParserWarnings = () => {
    cancelParserWarningShowFrame();
    setParserWarningsVisible(false);
    clearParserWarningHideTimer();
    parserWarningsHideTimerRef.current = setTimeout(() => {
      parserWarningsHideTimerRef.current = null;
      setParserWarnings([]);
    }, 180);
  };

  const handleExportSVG = (onDone: ExportDoneCallback) => {
    if (!hasGraph || !graphRef.current) {
      onDone(new Error("no-graph"));
      return;
    }
    Exporter.exportSVG({
      graphRef,
      hasGraph,
      containerRef,
      onError: setError,
      onDone,
      patchRelationshipLinkPoints,
      G6,
    });
  };

  const handleExportPNG = (onDone: ExportDoneCallback) => {
    if (!hasGraph || !graphRef.current) {
      onDone(new Error("no-graph"));
      return;
    }
    Exporter.exportPNG({
      graphRef,
      hasGraph,
      containerRef,
      onError: setError,
      onDone,
      patchRelationshipLinkPoints,
      G6,
    });
  };

  const handleExportJSON = (onDone: ExportDoneCallback) => {
    if (!hasGraph || !graphRef.current) {
      onDone(new Error("no-graph"));
      return;
    }
    onDone(null, () => downloadJson(currentState()));
  };

  const handleExportDrawio = (onDone: ExportDoneCallback) => {
    if (!hasGraph || !graphRef.current) {
      onDone(new Error("no-graph"));
      return;
    }
    Exporter.exportDrawio({
      graphRef,
      hasGraph,
      onError: setError,
      onDone,
      patchRelationshipLinkPoints,
    });
  };

  const runExport = (fmt: ExportFormat, onDone: ExportDoneCallback) => {
    if (fmt === "PNG") handleExportPNG(onDone);
    else if (fmt === "XML") handleExportDrawio(onDone);
    else if (fmt === "JSON") handleExportJSON(onDone);
    else handleExportSVG(onDone);
  };

  const {
    exportState,
    exportView,
    exportFmt,
    exportProgress,
    exportBtnRef: hookExportBtnRef,
    onExportBtnClick,
    onExportBtnKey,
    toExportIdle,
  } = useExportButton({ hasGraph, runExport, onError: setError });

  useUndoRedoShortcuts({
    graphRef,
    historyRef,
    onAfterChange: () => {
      if (graphRef.current && !graphRef.current.destroyed) {
        patchRelationshipLinkPoints(graphRef.current);
      }
    },
  });
  useWheelZoomRotate({
    containerRef,
    graphRef,
    historyRef,
    onAfterChange: () => {
      if (graphRef.current && !graphRef.current.destroyed) {
        patchRelationshipLinkPoints(graphRef.current);
      }
    },
  });

  const updateFontScaleFromPointer = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const track = el.querySelector(".font-size-slider-track");
    const rect = (track ?? el).getBoundingClientRect();
    const isHorizontal = rect.width > rect.height;
    const rawPct = isHorizontal
      ? (clientX - rect.left) / rect.width
      : 1 - (clientY - rect.top) / rect.height;
    const pct = Math.min(1, Math.max(0, rawPct));
    setFontScale(FONT_SCALE_MIN + pct * FONT_SCALE_RANGE);
  };

  const handleFontSliderPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFontScaleFromPointer(e.clientX, e.clientY, e.currentTarget);
  };

  const handleFontSliderPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    updateFontScaleFromPointer(e.clientX, e.clientY, e.currentTarget);
  };

  const handleFontSliderMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const slider = e.currentTarget;
    updateFontScaleFromPointer(e.clientX, e.clientY, slider);

    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      moveEvent.preventDefault();
      updateFontScaleFromPointer(moveEvent.clientX, moveEvent.clientY, slider);
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleFontSliderKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = e.shiftKey ? 0.1 : 0.03;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      setFontScale(fontScale + delta);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      setFontScale(fontScale - delta);
    } else if (e.key === "Home") {
      e.preventDefault();
      setFontScale(FONT_SCALE_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      setFontScale(FONT_SCALE_MAX);
    }
  };

  const fontSliderPct = ((fontScale - FONT_SCALE_MIN) / FONT_SCALE_RANGE) * 100;
  const exportButton = (
    <button
      ref={hookExportBtnRef}
      type="button"
      className="export-btn"
      data-state={exportState}
      disabled={!hasGraph}
      onClick={onExportBtnClick}
      onKeyDown={onExportBtnKey}
      aria-label={t.btnExportLabel}
    >
      <div
        className="export-progress"
        style={{
          width: `${exportProgress}%`,
          transitionDuration:
            exportProgress >= 100 ? "220ms" : exportProgress > 0 ? "2400ms" : "300ms",
          transitionTimingFunction:
            exportProgress >= 100
              ? "cubic-bezier(0.2, 0.7, 0.2, 1)"
              : exportProgress > 0
                ? "cubic-bezier(0, 0.6, 0.2, 1)"
                : "cubic-bezier(0, 0, 0.2, 1)",
        }}
      />
      <div className={`export-view export-view-idle${exportView === "idle" ? " is-on" : ""}`}>
        <span className="idle-label">{t.btnExportLabel}</span>
        <svg
          className="arrow-icon"
          viewBox="0 0 14 14"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 2v7.5m0 0l-3-3m3 3l3-3M2.5 12h9" />
        </svg>
      </div>
      <div className={`export-view export-view-open${exportView === "open" ? " is-on" : ""}`}>
        {EMBEDDED_EXPORT_FORMATS.map((fmt, index) => (
          <span className="embedded-export-item" key={fmt}>
            {index > 0 && <div className="export-sep" />}
            <div className="export-opt" data-fmt={fmt}>
              <span className="export-opt-label">{fmt}</span>
            </div>
          </span>
        ))}
        <div className="export-sep" />
        <div
          className="export-cancel"
          onClick={(e) => {
            e.stopPropagation();
            toExportIdle();
          }}
          aria-label="Cancel"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" x2="6" y1="6" y2="18" />
            <line x1="6" x2="18" y1="6" y2="18" />
          </svg>
        </div>
      </div>
      <div className={`export-view export-view-loading${exportView === "loading" ? " is-on" : ""}`}>
        <svg
          className="export-spinner"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="loading-label">
          {t.exportGenerating} {exportFmt}...
        </span>
      </div>
      <div className={`export-view export-view-success${exportView === "success" ? " is-on" : ""}`}>
        <svg
          className="check-icon"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 7.2l3 3 6-6" />
        </svg>
        <span className="success-label">{t.exportSaved}</span>
      </div>
    </button>
  );

  return (
    <div className="embedded-mode">
      <div className="main-content">
        <div className="input-section">
          <div className="card">
            <div className="card-header embedded-card-header">
              <h2 className="card-title">
                <span style={{ fontSize: "1.5rem" }}>📄</span>
                {t.cardInputTitle}
              </h2>
              <span className="embedded-readonly-badge">
                {lang === "zh" ? "只读" : "Read-only"}
              </span>
            </div>
            <div className="card-content embedded-input-content">
              <div className="embedded-editor-pane">
                <CodeEditor value={inputText} onChange={() => {}} readOnly />
              </div>
              <div className="button-group embedded-export-row">
                <div className="export-btn-wrap embedded-export-wrap">{exportButton}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="output-section">
          <div className="card">
            <div className="card-header embedded-preview-header">
              <div className="embedded-title-row">
                <h2 className="card-title">
                  <span style={{ fontSize: "1.5rem" }}>🎨</span>
                  {t.cardPreviewTitle}
                </h2>
                <div className="embedded-legend">
                  <div className="legend-item" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "3px",
                        background: isColored ? "#e0f2fe" : "#fff",
                        border: isColored ? "2px solid #0ea5e9" : "2px solid #1e293b",
                      }}
                    ></div>
                    <span>{t.legendEntity}</span>
                  </div>
                  <div className="legend-item" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        transform: "rotate(45deg)",
                        background: isColored ? "#f5f3ff" : "#fff",
                        border: isColored ? "2px solid #8b5cf6" : "2px solid #1e293b",
                      }}
                    ></div>
                    <span style={{ marginLeft: "4px" }}>{t.legendRelation}</span>
                  </div>
                  <div className="legend-item" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    <div
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: "#fff",
                        border: isColored ? "2px solid #94a3b8" : "2px solid #1e293b",
                      }}
                    ></div>
                    <span>{t.legendAttribute}</span>
                  </div>
                  <div className="legend-item" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "2px",
                      }}
                    >
                      <div
                        style={{
                          width: "10px",
                          height: "10px",
                          borderRadius: "50%",
                          background: isColored ? "#ecfdf5" : "#fff",
                          border: isColored ? "2px solid #10b981" : "2px solid #1e293b",
                          boxSizing: "border-box",
                        }}
                      ></div>
                      <div
                        style={{
                          width: "10px",
                          height: "2px",
                          borderRadius: "999px",
                          background: isColored ? "#10b981" : "#1e293b",
                        }}
                      ></div>
                    </div>
                    <span style={{ fontWeight: 600 }}>{t.legendPk}</span>
                  </div>
                </div>
              </div>
              <div className="embedded-header-actions">
                <button className="btn btn-sm btn-accent" onClick={fitView} disabled={!hasGraph}>
                  {lang === "zh" ? "适配画布" : "Fit canvas"}
                </button>
              </div>
            </div>

            <div className="card-content embedded-diagram-content">
              <div
                className={`diagram-container ${showBackground ? "" : "no-grid"}`}
                style={{ border: "none", borderRadius: 0 }}
              >
                <div
                  className="background-toggle"
                  onClick={() => setShowBackground(!showBackground)}
                  title={showBackground ? t.tipHideBg : t.tipShowBg}
                >
                  {showBackground ? <EyeIcon /> : <EyeSlashIcon />}
                </div>
                <div
                  className={`colorize-toggle ${isColored ? "active" : ""}`}
                  onClick={() => setIsColored(!isColored)}
                  title={isColored ? t.tipColorOff : t.tipColorOn}
                >
                  <PaletteIcon />
                </div>
                <div
                  className={`attrs-toggle ${hideFields ? "active" : ""}`}
                  onClick={() => setHideFields(!hideFields)}
                  title={hideFields ? t.tipShowAttrs : t.tipHideAttrs}
                >
                  <ListUlIcon />
                </div>
                <div
                  className={`force-toggle ${forceOn ? "active" : ""}`}
                  onClick={() => setForceOn(!forceOn)}
                  title={forceOn ? t.tipForceOff : t.tipForceOn}
                >
                  <CircleNodesIcon />
                </div>
                <div
                  className={`avoid-toggle ${autoAvoid ? "active" : ""}`}
                  onClick={() => setAutoAvoid(!autoAvoid)}
                  title={autoAvoid ? t.tipAutoAvoidOff : t.tipAutoAvoidOn}
                >
                  <ArrowsUpDownLeftRightIcon />
                </div>
                <div
                  className="font-size-slider"
                  title={t.tipFontSize}
                  role="slider"
                  tabIndex={0}
                  aria-label={t.tipFontSize}
                  aria-valuemin={FONT_SCALE_MIN}
                  aria-valuemax={FONT_SCALE_MAX}
                  aria-valuenow={Number(fontScale.toFixed(2))}
                  style={
                    {
                      "--font-slider-pct": `${fontSliderPct}%`,
                    } as CSSProperties
                  }
                  onPointerDown={handleFontSliderPointerDown}
                  onPointerMove={handleFontSliderPointerMove}
                  onMouseDown={handleFontSliderMouseDown}
                  onKeyDown={handleFontSliderKeyDown}
                >
                  <span className="font-size-slider-mark font-size-slider-mark-large">A</span>
                  <div className="font-size-slider-track" aria-hidden="true">
                    <div className="font-size-slider-fill" />
                    <div className="font-size-slider-thumb" />
                  </div>
                  <span className="font-size-slider-mark font-size-slider-mark-small">A</span>
                </div>
                {error && (
                  <div className={`diagram-error-overlay${errorVisible ? " is-visible" : ""}`}>
                    <div className="error-message">⚠️ {error}</div>
                  </div>
                )}
                {parserWarnings.length > 0 && (
                  <div
                    className={`parser-warning-toast${parserWarningsVisible ? " is-visible" : ""}`}
                    role="status"
                    aria-live="polite"
                  >
                    <button
                      type="button"
                      className="parser-warning-close"
                      aria-label={lang === "zh" ? "关闭解析警告" : "Dismiss parser warnings"}
                      onClick={dismissParserWarnings}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <line x1="18" x2="6" y1="6" y2="18" />
                        <line x1="6" x2="18" y1="6" y2="18" />
                      </svg>
                    </button>
                    <div className="parser-warning-title">
                      {lang === "zh" ? "解析警告" : "Parser warnings"}
                    </div>
                    <ul className="parser-warning-list">
                      {parserWarnings.slice(0, 4).map((warning, index) => (
                        <li key={`${warning.code}-${warning.line ?? "x"}-${index}`}>
                          {warning.message}
                        </li>
                      ))}
                    </ul>
                    {parserWarnings.length > 4 && (
                      <div className="parser-warning-more">
                        {lang === "zh"
                          ? `还有 ${parserWarnings.length - 4} 条`
                          : `${parserWarnings.length - 4} more`}
                      </div>
                    )}
                  </div>
                )}
                <div
                  ref={containerRef}
                  style={{
                    width: "100%",
                    height: "100%",
                    position: "relative",
                  }}
                />
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
