import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** The two fields that signal an open input-method composition. */
type ImeSignals = { isComposing?: boolean; keyCode?: number };

/**
 * True while an input method is composing, i.e. the key is going to the IME and
 * not to the application.
 *
 * This matters for every handler that treats Enter as "commit": while a
 * composition is open, Enter picks the highlighted candidate. Submitting there
 * sends the half-typed text, and for a pinyin user that is the normal way to
 * finish a word, not an edge case.
 *
 * Two signals are needed. `isComposing` is the standard one. `keyCode === 229`
 * is the legacy one that some Windows IMEs still report for the Enter that
 * commits a candidate, and it is precisely that Enter which must not submit.
 * Dropping either would leave a real IME unguarded.
 *
 * React's synthetic event and a native KeyboardEvent are both accepted, so the
 * same call works in a JSX `onKeyDown` and in a document-level listener.
 */
export function isImeComposing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const signals: ImeSignals = "nativeEvent" in event ? event.nativeEvent : event;
  return signals.isComposing === true || signals.keyCode === 229;
}
