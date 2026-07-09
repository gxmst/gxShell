import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

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
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });

  // Re-clamp on resize so wide cards (dual-pane) stay fully visible.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampPos(p.left, p.top, Math.min(width, window.innerWidth - 24)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: pos.left,
      startTop: pos.top,
    };
    e.preventDefault();
  }, [pos.left, pos.top]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const w = Math.min(width, window.innerWidth - 24);
      setPos(clampPos(dragRef.current.startLeft + dx, dragRef.current.startTop + dy, w));
    };
    const onUp = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEsc, true);
    return () => {
      document.removeEventListener("keydown", handleEsc, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  // Mount under .app-shell so theme CSS variables still apply. document.body
  // is outside the theme root and made panels look borderless / washed-out.
  const host =
    document.querySelector(".app-shell") ||
    document.getElementById("root") ||
    document.body;

  return createPortal(
    <div
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
      <div className="floating-card-drag-bar" onMouseDown={onHeaderMouseDown} />
      <button type="button" className="floating-card-close" onClick={onClose}>
        <X size={14} />
      </button>
      <div className="floating-card-body">{children}</div>
    </div>,
    host,
  );
}
