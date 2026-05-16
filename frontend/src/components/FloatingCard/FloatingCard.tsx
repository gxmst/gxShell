import { useRef, useState, useCallback, useEffect } from "react";
import { X } from "lucide-react";

interface FloatingCardProps {
  initialLeft: number;
  initialTop: number;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}

export function FloatingCard({ initialLeft, initialTop, width = 340, onClose, children }: FloatingCardProps) {
  const [pos, setPos] = useState({ left: initialLeft, top: initialTop });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 });

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, startLeft: pos.left, startTop: pos.top };
    e.preventDefault();
  }, [pos.left, pos.top]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPos({
        left: Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.startLeft + dx)),
        top: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.startTop + dy)),
      });
    };
    const onUp = () => { dragRef.current.active = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEsc, true);
    return () => { document.removeEventListener("keydown", handleEsc, true); };
  }, [onClose]);

  return (
    <div className="floating-card" style={{ left: pos.left, top: pos.top, width }}>
      <div className="floating-card-drag-bar" onMouseDown={onHeaderMouseDown} />
      <button className="floating-card-close" onClick={onClose}><X size={14} /></button>
      <div className="floating-card-body">{children}</div>
    </div>
  );
}
