import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function TabStrip({ children, activeTab, orderKey, pinned, onlyPinned, leftLabel, rightLabel }: {
  children: ReactNode; activeTab: string; orderKey: string; pinned?: boolean; onlyPinned?: boolean; leftLabel: string; rightLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const next = { overflow: host.scrollWidth > host.clientWidth + 1, left: host.scrollLeft > 1, right: host.scrollLeft + host.clientWidth < host.scrollWidth - 1 };
      setScroll((prior) => prior.overflow === next.overflow && prior.left === next.left && prior.right === next.right ? prior : next);
    };
    const reveal = () => {
      const active = Array.from(host.querySelectorAll<HTMLElement>(".tab[data-tab-id]")).find((tab) => tab.dataset.tabId === activeTab);
      if (active) {
        const bounds = host.getBoundingClientRect();
        const tab = active.getBoundingClientRect();
        if (tab.left < bounds.left) host.scrollLeft += tab.left - bounds.left;
        else if (tab.right > bounds.right) host.scrollLeft += tab.right - bounds.right;
      }
      update();
    };
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && host.scrollWidth > host.clientWidth) {
        event.preventDefault();
        host.scrollLeft += event.deltaY;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(host);
    for (const child of host.children) observer.observe(child);
    host.addEventListener("scroll", update);
    host.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); host.removeEventListener("scroll", update); host.removeEventListener("wheel", wheel); };
    // Inserting the arrows reduces the visible strip. Reveal again in the
    // committed layout rather than relying on a later observer notification.
  }, [activeTab, orderKey, scroll.overflow]);

  const move = (direction: number) => {
    const host = hostRef.current;
    if (host) host.scrollBy({ left: direction * Math.max(150, host.clientWidth * 0.8), behavior: "smooth" });
  };
  return <div className={`tabs-region${pinned ? " tabs-pinned-region" : ""}${onlyPinned ? " tabs-pinned-only" : ""}`} style={pinned ? { width: Children.count(children) * 150 } : undefined}>
    {scroll.overflow && <button className="tab-scroll-button" aria-label={leftLabel} title={leftLabel} disabled={!scroll.left} onClick={() => move(-1)}><ChevronLeft size={13} /></button>}
    <div className="tabs-scroll" ref={hostRef} data-pinned={pinned ? "true" : "false"}>{children}</div>
    {scroll.overflow && <button className="tab-scroll-button" aria-label={rightLabel} title={rightLabel} disabled={!scroll.right} onClick={() => move(1)}><ChevronRight size={13} /></button>}
  </div>;
}
