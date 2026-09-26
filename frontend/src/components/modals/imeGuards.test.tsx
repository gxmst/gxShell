import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearchModal } from "./SearchModals";
import type { CommandPaletteResult } from "./SearchModals";
import { TextInputDialog } from "./TextInputDialog";

// Enter means "commit" in every one of these handlers, and while an input method
// is composing Enter means "take the highlighted candidate" instead. The guard
// is one shared helper (utils/ime.ts); these cases pin that it is actually
// wired into the handlers, because the helper being correct is worth nothing if
// a handler forgets to call it.
//
// keyCode 229 is the shape a Windows IME reports for the committing Enter, and
// it is the one signal available in a jsdom event: `isComposing` is not settable
// through fireEvent's init object.

describe("TextInputDialog IME guard", () => {
  it("submits on a plain Enter", () => {
    const onSubmit = vi.fn();
    render(<TextInputDialog title="Rename" label="Name" initialValue="web-1" onSubmit={onSubmit} onClose={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("web-1");
  });

  it("does not submit on the Enter that commits an IME candidate", () => {
    const onSubmit = vi.fn();
    render(<TextInputDialog title="Rename" label="Name" initialValue="web-1" onSubmit={onSubmit} onClose={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229 });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("command palette IME guard", () => {
  // jsdom does not implement scrollIntoView, and the palette calls it whenever
  // the highlight moves. Stubbed locally rather than in the shared setup so the
  // files that assert on it keep owning it.
  let original: typeof Element.prototype.scrollIntoView;
  beforeEach(() => {
    original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  const build = () => {
    const action = vi.fn();
    const onClose = vi.fn();
    const results: CommandPaletteResult[] = [{ type: "command", title: "Restart nginx", subtitle: "", action }];
    render(<GlobalSearchModal query="" onQuery={vi.fn()} results={results} onClose={onClose} locale="zh-CN" />);
    return { action, onClose };
  };

  it("runs the highlighted result on a plain Enter", () => {
    const { action, onClose } = build();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  // Without the guard this ran whatever was highlighted, so committing a pinyin
  // word would execute an unrelated command.
  it("does not run anything on the Enter that commits an IME candidate", () => {
    const { action, onClose } = build();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", keyCode: 229 });

    expect(action).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Escape cancels the composition, so it must not also close the palette.
  // ModalShell has its own Escape listener, so this covers both: the palette's
  // own handler and the shell's.
  it("does not close on the Escape that cancels a composition", () => {
    const { onClose } = build();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a plain Escape", () => {
    const { onClose } = build();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });
});
