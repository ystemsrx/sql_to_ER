import { useEffect, useRef, useState } from "react";
import type { I18N } from "./i18n";
import type { SnapshotRecord } from "./types";

type Translation = (typeof I18N)[keyof typeof I18N];

interface HistoryOverlayProps {
  open: boolean;
  items: SnapshotRecord[];
  t: Translation;
  onClose: () => void;
  onRestore: (snap: SnapshotRecord) => void;
  onDelete: (id: string) => void;
  formatTimestamp: (ts: number | undefined) => string;
}

interface TrackState {
  targetScroll: number;
  currentScroll: number;
  isDragging: boolean;
  startX: number;
  startScroll: number;
  velocity: number;
  lastX: number;
  wheelTimeout: ReturnType<typeof setTimeout> | null;
  shiftValues: number[];
  // 本次按下后是否真的发生了拖动；用来抑制 pointerup 之后那次
  // "幽灵 click" —— 否则在聚焦卡上拖完一松手就会被当成点击恢复。
  didDrag: boolean;
}

// ─────────────────────────────────────────────────────────
// HistoryOverlay：滑动卡片形式展示生成历史
// 实现思路对齐 example.jsx：3D 透视轨道 + 拖拽/滚轮滚动 + 吸附阻力。
//  - targetScroll 是吸附目标位置（整数）；currentScroll 用 lerp 追赶
//  - 焦点卡片 shift→1，被抽离到右侧；其余卡片保持轨道侧 -55° 旋转
// ─────────────────────────────────────────────────────────
export const HistoryOverlay = ({
  open,
  items,
  t,
  onClose,
  onRestore,
  onDelete,
  formatTimestamp,
}: HistoryOverlayProps) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const stateRef = useRef<TrackState>({
    targetScroll: 0,
    currentScroll: 0,
    isDragging: false,
    startX: 0,
    startScroll: 0,
    velocity: 0,
    lastX: 0,
    wheelTimeout: null,
    shiftValues: [],
    didDrag: false,
  });
  const [hintVisible, setHintVisible] = useState(true);
  const [focusIdx, setFocusIdx] = useState(0);
  // { [snap.id]: number }，背景图 Y 方向偏移百分比（0 = 顶，50 = 视觉居中）
  // 数据驱动：图越扁，缩略图被 contain 缩到的高度越小，下方留白越多，
  // 完全靠顶看起来"飘"。把空白按比例分给上方，瘦高图直接 0%（本身就铺满）。
  const [thumbY, setThumbY] = useState<Record<string, number>>({});

  // 列表变化或重新打开时，重置滚动到第 0 张
  useEffect(() => {
    if (!open) return;
    const s = stateRef.current;
    s.targetScroll = 0;
    s.currentScroll = 0;
    s.shiftValues = items.map(() => 0);
    setFocusIdx(0);
    setHintVisible(true);
  }, [open, items.length]);

  // 测量每张快照的宽高比，算出该张缩略图应有的 Y 偏移
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const isMobile = window.innerWidth < 768;
    const cardW = isMobile ? 260 : 320;
    const cardH = isMobile ? 360 : 420;
    const thumbW = cardW - 32;
    const thumbH = cardH - 18 - cardH * 0.38;
    const containerRatio = thumbW / thumbH;

    items.forEach((snap) => {
      if (!snap || !snap.thumbnail) return;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        if (!iw || !ih) return;
        const imageRatio = iw / ih;
        const emptyFrac = Math.max(0, 1 - containerRatio / imageRatio);
        const y = Math.min(50, emptyFrac * 55);
        setThumbY((prev) => {
          if (Math.abs((prev[snap.id] || 0) - y) < 0.5) return prev;
          return { ...prev, [snap.id]: y };
        });
      };
      img.src = snap.thumbnail;
    });
    return () => {
      cancelled = true;
    };
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const container = trackRef.current;
    if (!container) return;
    const total = items.length;
    if (total === 0) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // 卡内按钮 / 链接 / 输入控件按下时不进入拖拽：
      // 否则原生 click 还没派发，targetScroll 已经在 pointermove 里被改动，
      // 视觉吸附会"吃掉"用户的点击。
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        tgt.closest &&
        tgt.closest("button, a, input, select, textarea, [data-no-drag]")
      ) {
        return;
      }
      const s = stateRef.current;
      s.isDragging = true;
      s.didDrag = false;
      s.startX = e.clientX;
      s.startScroll = s.targetScroll;
      s.velocity = 0;
      s.lastX = s.startX;
      setHintVisible(false);
      container.classList.add("is-dragging");
    };

    const handlePointerMove = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s.isDragging) return;
      if (e.pointerType === "mouse" && e.buttons === 0) {
        handlePointerUp();
        return;
      }
      const currentX = e.clientX;
      const deltaX = currentX - s.startX;
      // 4px 阈值过滤掉鼠标抖动 / 触控板微小漂移
      if (!s.didDrag && Math.abs(deltaX) > 4) s.didDrag = true;
      s.targetScroll = s.startScroll - deltaX * 0.006;
      s.targetScroll = Math.max(-0.5, Math.min(total - 0.5, s.targetScroll));
      s.velocity = currentX - s.lastX;
      s.lastX = currentX;
    };

    const handlePointerUp = () => {
      const s = stateRef.current;
      if (!s.isDragging) return;
      s.isDragging = false;
      container.classList.remove("is-dragging");
      let projected = s.targetScroll - s.velocity * 0.02;
      const baseIndex = Math.round(s.startScroll);
      const diff = projected - baseIndex;
      let finalTarget;
      if (Math.abs(diff) < 0.6) {
        finalTarget = baseIndex;
      } else {
        finalTarget = Math.round(projected);
      }
      s.targetScroll = Math.max(0, Math.min(total - 1, finalTarget));
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = stateRef.current;
      s.targetScroll += e.deltaY * 0.003;
      s.targetScroll = Math.max(0, Math.min(total - 1, s.targetScroll));
      if (s.wheelTimeout) clearTimeout(s.wheelTimeout);
      s.isDragging = true;
      s.wheelTimeout = setTimeout(() => {
        s.isDragging = false;
        s.targetScroll = Math.round(s.targetScroll);
      }, 150);
      setHintVisible(false);
    };

    container.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("wheel", handleWheel, { passive: false });

    let raf = 0;
    const loop = () => {
      const s = stateRef.current;
      const isMobile = window.innerWidth < 768;
      s.currentScroll += (s.targetScroll - s.currentScroll) * 0.08;

      const focusedIndex = Math.round(s.targetScroll);
      if (focusedIndex !== focusIdx) setFocusIdx(focusedIndex);

      for (let i = 0; i < total; i++) {
        const rel = i - s.currentScroll;
        const distanceToFocus = Math.abs(i - s.targetScroll);
        const highlight = Math.max(0, 1 - distanceToFocus * 1.0);

        const isTarget = !s.isDragging && Math.round(s.targetScroll) === i;
        const isCloseEnough = Math.abs(rel) < 0.6;
        // 静止吸附时聚焦卡 shift→1 完全抽离；
        // 拖动时给最近的卡一个 0~0.55 的部分抬起，按 highlight 平滑过渡，
        // 这样手在动的过程中也能看到当前会停在哪张卡片上。
        let shiftTarget = isTarget && isCloseEnough ? 1 : 0;
        if (s.isDragging) {
          shiftTarget = Math.max(shiftTarget, highlight * 0.4);
        }
        if (s.shiftValues[i] === undefined) s.shiftValues[i] = 0;
        s.shiftValues[i] += (shiftTarget - s.shiftValues[i]) * 0.1;
        const shift = s.shiftValues[i];

        const highlightOffsetX = highlight * (isMobile ? 40 : 80);
        const highlightRotY = highlight * 15;

        const trackX =
          (isMobile ? -80 : -window.innerWidth * 0.18) + highlightOffsetX;
        const trackY = 0;
        const trackZ = -rel * (isMobile ? 320 : 550);
        // 把轨道侧基础旋转从 -55° 收一点到 -42°，
        // 让非焦点卡也能稍微正对屏幕，缩略图内容更易辨识
        const trackRotY = -42 + highlightRotY;

        const activeX = isMobile ? 0 : window.innerWidth * 0.15;
        const activeY = 0;
        const activeZ = 120;
        const activeRotY = 0;

        const x = trackX + (activeX - trackX) * shift;
        const y = trackY + (activeY - trackY) * shift;
        const z = trackZ + (activeZ - trackZ) * shift;
        const rotY = trackRotY + (activeRotY - trackRotY) * shift;
        const scale = 0.75 + 0.4 * shift;

        let opacity = 1;
        if (rel > 5) opacity = Math.max(0, 1 - (rel - 5) * 0.5);
        if (rel < -3) opacity = Math.max(0, 1 + (rel + 3) * 0.5);

        const el = cardRefs.current[i];
        if (el) {
          el.style.transform = `translate3d(-50%, -50%, 0) translateX(${x}px) translateY(${y}px) translateZ(${z}px) rotateY(${rotY}deg) scale(${scale})`;
          el.style.opacity = String(opacity);
          el.style.zIndex = String(
            Math.round(1000 - Math.abs(rel) * 10 + shift * 100),
          );
          el.style.setProperty("--shift", String(shift));
        }
      }

      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("wheel", handleWheel);
      cancelAnimationFrame(raf);
      if (stateRef.current.wheelTimeout) {
        clearTimeout(stateRef.current.wheelTimeout);
      }
    };
  }, [open, items.length]);

  const focusOn = (i: number) => {
    const s = stateRef.current;
    s.targetScroll = i;
    setHintVisible(false);
  };

  const handleCardClick = (i: number) => {
    // 拖动结束时浏览器仍会派发一次 click，吞掉它，避免在聚焦卡上
    // 一拖一松就触发恢复
    const s = stateRef.current;
    if (s.didDrag) {
      s.didDrag = false;
      return;
    }
    if (i !== focusIdx) {
      focusOn(i);
      return;
    }
    const snap = items[i];
    if (snap) onRestore(snap);
  };

  return (
    <div className={`history-overlay${open ? " is-open" : ""}`}>
      <div className="history-header">
        <i className="fa-solid fa-clock-rotate-left"></i>
        <span>{t.historyTitle}</span>
        {items.length > 0 && (
          <span className="history-count">· {items.length}</span>
        )}
      </div>
      <button
        type="button"
        className="history-close"
        onClick={onClose}
        aria-label={t.historyClose}
        title={t.historyClose}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" x2="6" y1="6" y2="18" />
          <line x1="6" x2="18" y1="6" y2="18" />
        </svg>
      </button>

      {items.length === 0 ? (
        <div className="history-empty">
          <div className="history-empty-card">
            <div className="history-empty-icon-wrap">
              <i className="fa-solid fa-clock-rotate-left"></i>
            </div>
            <div className="history-empty-title">{t.historyEmpty}</div>
            <div className="history-empty-hint">{t.historyEmptyHint}</div>
          </div>
        </div>
      ) : (
        <>
          <div ref={trackRef} className="history-track">
            {items.map((snap, i) => {
              const entityCount = (snap.nodes || []).filter(
                (n) =>
                  typeof n.id === "string" && n.id.indexOf("entity-") === 0,
              ).length;
              const tags: string[] = [];
              tags.push(snap.isColored ? t.historyColored : t.historyMono);
              if (snap.hideFields) tags.push(t.historyAttrsHidden);
              if (snap.showComment) tags.push(t.historyComment);
              tags.push(`${entityCount} ${t.historyEntities}`);
              return (
                <div
                  key={snap.id}
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  className="history-card"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCardClick(i);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {snap.thumbnail ? (
                    <div
                      className="history-card-thumb"
                      style={{
                        backgroundImage: `url(${snap.thumbnail})`,
                        backgroundPosition: `center ${thumbY[snap.id] || 0}%`,
                      }}
                    />
                  ) : (
                    <div className="history-card-thumb is-empty">
                      <i className="fa-solid fa-diagram-project"></i>
                    </div>
                  )}
                  <div className="history-card-track-overlay" />
                  <div className="history-card-shade" />
                  <div className="history-card-meta">
                    <span className="history-card-eyebrow">
                      {formatTimestamp(snap.updatedAt)}
                    </span>
                    <div className="history-card-tags">
                      {tags.map((tg, k) => (
                        <span key={k}>{tg}</span>
                      ))}
                    </div>
                    <div className="history-card-actions">
                      <button
                        type="button"
                        className="history-card-restore"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRestore(snap);
                        }}
                      >
                        <i className="fa-solid fa-rotate-left"></i>
                        {t.historyRestore}
                      </button>
                      <button
                        type="button"
                        className="history-card-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(snap.id);
                        }}
                      >
                        <i className="fa-solid fa-trash"></i>
                        {t.historyDelete}
                      </button>
                    </div>
                  </div>
                  <div className="history-card-frame" />
                </div>
              );
            })}
          </div>
          <div
            className="history-hint"
            style={{ opacity: hintVisible ? 1 : 0 }}
          >
            <i className="fa-solid fa-arrows-left-right"></i>
            <span>{t.historyHint}</span>
          </div>
        </>
      )}
    </div>
  );
};
