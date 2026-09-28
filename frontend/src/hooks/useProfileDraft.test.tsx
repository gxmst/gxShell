import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearProfileDrafts, useDiscardGuard, useProfileDraft } from "./useProfileDraft";

afterEach(() => clearProfileDrafts());

describe("useProfileDraft", () => {
  it.each([false, true])("retires an unchanged saved draft after unmount (remounted=%s)", (remounted) => {
    const first = renderHook(() => useProfileDraft<object | null>("saved", "a", null));
    const submitted = { text: "saved" };
    act(() => first.result.current[1](submitted));
    const complete = first.result.current[2];
    first.unmount();
    const second = remounted ? renderHook(() => useProfileDraft<object | null>("saved", "a", null)) : null;
    act(() => { expect(complete(submitted, null)).toBe(false); });
    if (second) expect(second.result.current[0]).toBeNull();
    const third = renderHook(() => useProfileDraft<object | null>("saved", "a", null));
    expect(third.result.current[0]).toBeNull();
  });
  it("only completes the immutable snapshot submitted by a save", () => {
    const { result } = renderHook(() => useProfileDraft<{ text: string } | null>("t", "a", null));
    const submitted = { text: "submitted" };
    act(() => result.current[1](submitted));
    const complete = result.current[2];
    act(() => result.current[1]({ text: "new edits" }));
    act(() => expect(complete(submitted, null)).toBe(false));
    expect(result.current[0]?.text).toBe("new edits");
    act(() => expect(result.current[2](result.current[0], null)).toBe(true));
    expect(result.current[0]).toBeNull();
  });

  it("ignores updates from a panel that no longer owns the host", () => {
    const first = renderHook(() => useProfileDraft<string | null>("t", "a", null));
    act(() => first.result.current[1]("submitted"));
    const [, update, complete] = first.result.current;
    first.unmount();
    const second = renderHook(() => useProfileDraft<string | null>("t", "a", null));
    act(() => second.result.current[1]("new edits"));
    act(() => { update("stale load"); expect(complete("submitted", null)).toBe(false); });
    second.unmount();
    const third = renderHook(() => useProfileDraft<string | null>("t", "a", null));
    expect(third.result.current[0]).toBe("new edits");
  });
  it("keeps each host's draft apart, so returning to a host finds it again", () => {
    const { result, rerender } = renderHook(
      ({ profileId }: { profileId: string }) => useProfileDraft<string | null>("t", profileId, null),
      { initialProps: { profileId: "a" } },
    );
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]("draft a"));
    rerender({ profileId: "b" });
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]("draft b"));
    rerender({ profileId: "a" });
    expect(result.current[0]).toBe("draft a");
    rerender({ profileId: "b" });
    expect(result.current[0]).toBe("draft b");
  });

  it("outlives the component, which is what a drawer switch does to the panel", () => {
    const first = renderHook(() => useProfileDraft<string | null>("t", "a", null));
    act(() => first.result.current[1]("unsaved"));
    first.unmount();

    const second = renderHook(() => useProfileDraft<string | null>("t", "a", null));
    expect(second.result.current[0]).toBe("unsaved");
  });

  it("leaves the draft alone when only the session id changes", () => {
    // A draft belongs to the host. A second terminal on the same server, and an
    // auto-reconnect that hands the session a new id, both keep the profileId -
    // so the hook must not touch the draft at all.
    const { result, rerender } = renderHook(
      ({ profileId }: { profileId: string }) => useProfileDraft<string | null>("t", profileId, null),
      { initialProps: { profileId: "host" } },
    );
    act(() => result.current[1]("draft"));
    rerender({ profileId: "host" });
    expect(result.current[0]).toBe("draft");
  });

  it("accepts an updater, so two writes in one frame cannot clobber each other", () => {
    const { result } = renderHook(() => useProfileDraft<{ text: string } | null>("t", "a", null));
    act(() => result.current[1]({ text: "" }));
    act(() => result.current[1]((prev) => ({ text: `${prev?.text ?? ""}a` })));
    act(() => result.current[1]((prev) => ({ text: `${prev?.text ?? ""}b` })));
    expect(result.current[0]).toEqual({ text: "ab" });
  });

  it("keeps the two panels from sharing a namespace", () => {
    const sites = renderHook(() => useProfileDraft<string | null>("websites", "host", null));
    const cron = renderHook(() => useProfileDraft<string | null>("cron", "host", null));
    act(() => sites.result.current[1]("site draft"));
    expect(cron.result.current[0]).toBeNull();
  });
});

describe("useDiscardGuard", () => {
  it("runs the action straight away when there is nothing to lose", () => {
    const { result } = renderHook(() => useDiscardGuard(false));
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it("holds the action back until the question is answered", () => {
    const { result } = renderHook(() => useDiscardGuard(true));
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.pending).toBeTypeOf("function");

    // Discarding is the caller running the action it was handed.
    act(() => result.current.pending?.());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("forgets the held action when the user keeps editing", () => {
    const { result } = renderHook(() => useDiscardGuard(true));
    const action = vi.fn();
    act(() => result.current.guard(action));
    act(() => result.current.dismiss());
    expect(result.current.pending).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
});
