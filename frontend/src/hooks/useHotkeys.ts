import { useEffect, useRef } from "react";

type HotkeyOptions = {
  activeTab: string;
  onGlobalSearch: () => void;
  onTerminalSearch: () => void;
  onCloseTab: (id: string) => void;
};

export function useHotkeys(options: HotkeyOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const opts = optionsRef.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        opts.onGlobalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        opts.onTerminalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "w" && opts.activeTab) {
        event.preventDefault();
        opts.onCloseTab(opts.activeTab);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
