import { useEffect } from "react";

type HotkeyOptions = {
  activeTab: string;
  onGlobalSearch: () => void;
  onTerminalSearch: () => void;
  onCloseTab: (id: string) => void;
};

export function useHotkeys(options: HotkeyOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        options.onGlobalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        options.onTerminalSearch();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "w" && options.activeTab) {
        event.preventDefault();
        options.onCloseTab(options.activeTab);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options]);
}

