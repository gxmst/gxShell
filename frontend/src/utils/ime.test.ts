import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime";

/** A native keyboard event carrying only the fields the helper reads. */
const native = (fields: { isComposing?: boolean; keyCode?: number }) =>
  fields as unknown as KeyboardEvent;

/** A React synthetic event, which exposes the same fields via nativeEvent. */
const synthetic = (fields: { isComposing?: boolean; keyCode?: number }) =>
  ({ nativeEvent: fields }) as unknown as React.KeyboardEvent;

describe("isImeComposing", () => {
  it("reads isComposing from a synthetic event", () => {
    expect(isImeComposing(synthetic({ isComposing: true }))).toBe(true);
  });

  it("reads isComposing from a native event", () => {
    expect(isImeComposing(native({ isComposing: true }))).toBe(true);
  });

  // The legacy signal some Windows IMEs report for the Enter that commits a
  // candidate. It is the only sign that Enter is not a submit, so losing it
  // would send the half-typed text on exactly the keystroke that finishes a word.
  it("treats keyCode 229 as composing on either event shape", () => {
    expect(isImeComposing(synthetic({ keyCode: 229 }))).toBe(true);
    expect(isImeComposing(native({ keyCode: 229 }))).toBe(true);
  });

  it("does not treat a plain Enter as composing", () => {
    expect(isImeComposing(synthetic({ isComposing: false, keyCode: 13 }))).toBe(false);
    expect(isImeComposing(native({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  // Events are not always fully populated: a document-level listener can see an
  // event whose isComposing is undefined, and that must read as "not composing"
  // so ordinary typing keeps working.
  it("reads absent fields as not composing", () => {
    expect(isImeComposing(native({}))).toBe(false);
    expect(isImeComposing(synthetic({}))).toBe(false);
  });
});
