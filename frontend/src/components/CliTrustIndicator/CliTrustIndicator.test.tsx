import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { CliTrustIndicator } from "./CliTrustIndicator";

describe("full CLI trust indicator", () => {
  afterEach(() => vi.useRealTimers());

  it("shows full trust, revokes the correct server and disappears on expiry", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-11-09T08:00:00Z");
    vi.setSystemTime(now);
    const profile = new types.Profile({ id: "prod", cliEnabled: true, cliTrustMode: "full", cliTrustUntil: new Date(now + 2000).toISOString() });
    const onRevoke = vi.fn();
    render(<CliTrustIndicator profile={profile} locale="zh-CN" revoking={false} onRevoke={onRevoke} />);
    const button = screen.getByRole("button", { name: /CLI 完全信任/ });
    expect(button).toHaveAttribute("title", expect.stringContaining("0:00:02"));
    fireEvent.click(button);
    expect(onRevoke).toHaveBeenCalledWith("prod");
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
