import type { KeyboardEvent } from "react";

// Automatic activation keeps focus and the visible panel together. Tab still
// leaves the tablist through its single selected-tab stop.
export function handleTabKeyDown(event: KeyboardEvent<HTMLElement>) {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.findIndex((tab) => tab === event.target);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight": next = (index + 1) % tabs.length; break;
    case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
    case "Home": next = 0; break;
    case "End": next = tabs.length - 1; break;
    default: return;
  }
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
