import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isImeComposing } from "../../utils/ime";
import { hasActiveOverlay } from "../../utils/overlayManager";

// Open cards, oldest first. Every card listens for Escape on document, so an
// order is needed: without one a single Escape closed all of them at once.
const openCards: object[] = [];

interface FloatingCardProps {
  initialLeft?: number;
  initialTop?: number;
  width?: number;
  /** Prefer centered on the full viewport (not the sidebar). */
  center?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

function clampPos(left: number, top: number, width: number) {
  const maxLeft = Math.max(8, window.innerWidth - Math.min(width, window.innerWidth - 16) - 8);
  const maxTop = Math.max(8, window.innerHeight - 48);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top: Math.min(Math.max(8, top), maxTop),
  };
}

function resolveInitial(props: {
  initialLeft?: number;
  initialTop?: number;
  width: number;
  center?: boolean;
}) {
  const width = Math.min(props.width, typeof window !== "undefined" ? window.innerWidth - 24 : props.width);
  if (props.center || props.initialLeft == null || props.initialTop == null) {
    return clampPos(
      (window.innerWidth - width) / 2,
      Math.max(28, Math.round(window.innerHeight * 0.1)),
      width,
    );
  }
  return clampPos(props.initialLeft, props.initialTop, width);
}

/**
 * Viewport-level floating panel. Portaled to the app shell so sidebar parents
 * cannot clip it while theme variables still resolve.
 */
export function FloatingCard({
  initialLeft,
  initialTop,
  width = 340,
  center,
  onClose,
  children,
}: FloatingCardProps) {
  const safeWidth = useMemo(
    () => Math.min(width, typeof window !== "undefined" ? window.innerWidth - 24 : width),
    [width],
  );
  const [pos, setPos] = useState(() =>
    resolveInitial({ initialLeft, initialTop, width: safeWidth, center }),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });
  const livePosRef = useRef(pos);
  const frameRef = useRef(0);
  // Stable identity for this card's slot in the Escape order.
  const cardTokenRef = useRef<object | null>(null);
  if (cardTokenRef.current === null) cardTokenRef.current = {};

  // Re-clamp on resize so wide cards (dual-pane) stay fully visible.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampPos(p.left, p.top, Math.min(width, window.innerWidth - 24)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    livePosRef.current = pos;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: pos.left,
      startTop: pos.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [pos]);

  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const w = Math.min(width, window.innerWidth - 24);
    livePosRef.current = clampPos(
      dragRef.current.startLeft + e.clientX - dragRef.current.startX,
      dragRef.current.startTop + e.clientY - dragRef.current.startY,
      w,
    );
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.left = `${livePosRef.current.left}px`;
      panel.style.top = `${livePosRef.current.top}px`;
    });
  }, [width]);

  const finishHeaderGesture = useCallback((cancelled = false) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    if (cancelled) {
      livePosRef.current = pos;
      if (panelRef.current) {
        panelRef.current.style.left = `${pos.left}px`;
        panelRef.current.style.top = `${pos.top}px`;
      }
    } else {
      setPos(livePosRef.current);
    }
  }, [pos]);

  // Escape has to be registered once per mount, not once per render.
  //
  // Every call site passes an inline arrow, so `onClose` has a new identity on
  // each render of the card's parent. Depending on it re-ran this effect each
  // time, and the cleanup removes this card's token from `openCards` before the
  // effect pushes it back — so a card that merely re-rendered moved to the end
  // of the stack. Cards do not all live in the same subtree (a monitor card
  // hangs off the sidebar, a transfer window off the SFTP panel), so one can
  // re-render while another does not, and the order stopped matching the
  // stacking order: Escape then either closed the card underneath or, when the
  // focus was in an input, closed nothing at all. The handler reads the latest
  // callback from a ref instead.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const token = cardTokenRef.current;
    if (!token) return;
    openCards.push(token);
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape cancels an open IME composition, and cancelling a candidate is
      // routine while typing a path in Chinese. The focus test below deliberately
      // claims Escape from an input inside this card, so without this the card
      // would close and take the draft with it.
      if (isImeComposing(e)) return;
      // A modal owns Escape while it is open, so Escape must not also dismiss
      // the card behind it — that is how pressing Escape in a transfer conflict
      // dialog used to close the whole transfer window.
      if (hasActiveOverlay()) return;
      // Only the topmost card closes.
      if (openCards[openCards.length - 1] !== token) return;
      const target = e.target instanceof Element ? e.target : null;
      const panel = panelRef.current;
      const ownsFocus = !!panel && !!target && panel.contains(target);
      // Escape belongs to whoever holds the focus: a terminal running vim, a
      // search field, an editor. Only a card that owns the focus — or one open
      // with the focus on the app chrome — claims the key.
      if (!ownsFocus && target?.closest(".xterm, input, textarea, select, [contenteditable='true']")) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleEsc, true);
    return () => {
      document.removeEventListener("keydown", handleEsc, true);
      const index = openCards.lastIndexOf(token);
      if (index >= 0) openCards.splice(index, 1);
    };
  }, []);

  if (typeof document === "undefined") return null;

  // Mount under .app-shell so theme CSS variables still apply. document.body
  // is outside the theme root and made panels look borderless / washed-out.
  const host =
    document.querySelector(".app-shell") ||
    document.getElementById("root") ||
    document.body;

  return createPortal(
    <div
      ref={panelRef}
      className="floating-card"
      style={{
        left: pos.left,
        top: pos.top,
        width: safeWidth,
        maxWidth: "calc(100vw - 24px)",
      }}
      role="dialog"
      aria-modal="false"
    >
      <div
        className="floating-card-drag-bar"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={() => finishHeaderGesture()}
        onPointerCancel={() => finishHeaderGesture(true)}
      />
      <button type="button" className="floating-card-close" onClick={onClose}>
        <X size={14} />
      </button>
      <div className="floating-card-body">{children}</div>
    </div>,
    host,
  );
}
