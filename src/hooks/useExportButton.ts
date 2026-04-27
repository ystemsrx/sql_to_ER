import { useEffect, useRef, useState } from "react";

export type ExportFormat = "PNG" | "SVG" | "XML";
export type ExportState = "idle" | "open" | "loading" | "success";
export type ExportView = ExportState | null;

export type ExportDoneCallback = (
  err: unknown,
  triggerDownload?: (() => void) | null,
) => void;

export interface UseExportButtonOptions {
  hasGraph: boolean;
  // 由调用方决定如何针对某种格式发起"准备"，并在准备完成后调用 onDone。
  // 第二个参数是"真正保存文件"的函数，由调用方在文件就绪时交回。
  runExport: (fmt: ExportFormat, onDone: ExportDoneCallback) => void;
  onError: (message: string) => void;
}

export function useExportButton({
  hasGraph,
  runExport,
  onError,
}: UseExportButtonOptions) {
  // 动效导出按钮：idle → open → loading → success → idle
  const [exportState, setExportState] = useState<ExportState>("idle");
  // 错位显示的 view（短暂置 null 以触发离场动画）
  const [exportView, setExportView] = useState<ExportView>("idle");
  const [exportFmt, setExportFmt] = useState<ExportFormat>("PNG");
  const [exportProgress, setExportProgress] = useState(0);
  const exportBtnRef = useRef<HTMLButtonElement | null>(null);
  const exportTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearExportTimers = () => {
    exportTimersRef.current.forEach(clearTimeout);
    exportTimersRef.current = [];
  };
  const addExportTimer = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    exportTimersRef.current.push(id);
    return id;
  };

  const toExportIdle = () => {
    clearExportTimers();
    setExportState("idle");
    setExportView(null);
    addExportTimer(() => setExportView("idle"), 240);
    setExportProgress(0);
  };
  const toExportOpen = () => {
    if (!hasGraph) return;
    clearExportTimers();
    setExportState("open");
    setExportView(null);
    addExportTimer(() => setExportView("open"), 220);
  };
  const toExportLoading = (fmt: ExportFormat) => {
    clearExportTimers();
    setExportFmt(fmt);
    setExportState("loading");
    setExportView(null);
    setExportProgress(0);

    // phase.done 记录准备完成；triggerDownload 是"真正保存文件"的函数，
    // 由 runExport 在文件就绪时交回，我们在进度到 100% 的那一刻再调用它。
    const phase: {
      done: boolean;
      rampStartedAt: number;
      triggerDownload: (() => void) | null;
    } = {
      done: false,
      rampStartedAt: 0,
      triggerDownload: null,
    };
    const MIN_RAMP_MS = 260;

    const finalizeAfter = (wait: number) => {
      addExportTimer(() => {
        // 进度走满的同一瞬间触发实际下载
        if (phase.triggerDownload) {
          try {
            phase.triggerDownload();
          } catch (e: unknown) {
            const msg =
              e && typeof e === "object" && "message" in e
                ? String((e as { message?: unknown }).message)
                : String(e);
            onError(msg);
          }
        }
        setExportProgress(100);
        addExportTimer(() => {
          setExportState("success");
          setExportView(null);
          addExportTimer(() => setExportView("success"), 160);
          addExportTimer(() => toExportIdle(), 2000);
        }, 240);
      }, wait);
    };

    const onDone: ExportDoneCallback = (err, download) => {
      if (err) {
        toExportIdle();
        return;
      }
      phase.done = true;
      phase.triggerDownload = download || null;
      // 如果视图还没出现，等视图出现的定时器里再判定完成
      if (phase.rampStartedAt === 0) return;
      const elapsed = performance.now() - phase.rampStartedAt;
      finalizeAfter(Math.max(0, MIN_RAMP_MS - elapsed));
    };

    // 切换到 loading view 并启动"爬升到 85%"的慢动画。
    // 若此时准备工作已完成，直接安排完成流程（保证进度条最少可见 MIN_RAMP_MS）。
    addExportTimer(() => {
      setExportView("loading");
      phase.rampStartedAt = performance.now();
      setExportProgress(85);
      if (phase.done) finalizeAfter(MIN_RAMP_MS);
    }, 160);

    runExport(fmt, onDone);
  };

  // 点击按钮外部折叠；按 Esc 折叠
  useEffect(() => {
    if (exportState !== "open") return;
    const onDown = (e: MouseEvent) => {
      if (!exportBtnRef.current) return;
      if (!exportBtnRef.current.contains(e.target as Node)) toExportIdle();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toExportIdle();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [exportState]);

  useEffect(() => () => clearExportTimers(), []);

  const onExportBtnClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (exportState === "idle") {
      toExportOpen();
      return;
    }
    if (exportState === "open") {
      const target = e.target as HTMLElement | null;
      const opt = target && target.closest && target.closest(".export-opt");
      if (opt) {
        const fmt = (opt as HTMLElement).dataset.fmt as ExportFormat | undefined;
        if (fmt) toExportLoading(fmt);
      }
    }
  };
  const onExportBtnKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "Enter" || e.key === " ") && exportState === "idle") {
      e.preventDefault();
      toExportOpen();
    }
  };

  return {
    exportState,
    exportView,
    exportFmt,
    exportProgress,
    exportBtnRef,
    onExportBtnClick,
    onExportBtnKey,
    toExportIdle,
  };
}
