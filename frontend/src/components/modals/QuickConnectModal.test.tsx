import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { QuickConnectModal } from "./QuickConnectModal";

describe("QuickConnectModal", () => {
  it("reuses the saved profile id when a saved connection is retried", async () => {
    const onSave = vi.fn(async (profile: types.Profile) => new types.Profile({ ...profile, id: "saved-profile" }));
    const onConnect = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();

    render(
      <QuickConnectModal
        language="en"
        onClose={onClose}
        onPickKey={async () => ""}
        onSave={onSave}
        onConnect={onConnect}
      />,
    );

    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Save this connection/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection saved, but connecting failed");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].id).toBe("");
    expect(onConnect.mock.calls[0][0]).toMatchObject({ id: "saved-profile", password: "secret" });

    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0].id).toBe("saved-profile");
    expect(onConnect).toHaveBeenCalledTimes(2);
  });

  it("reports a failed saved connection in the interface language", async () => {
    const onSave = vi.fn(async (profile: types.Profile) => new types.Profile({ ...profile, id: "saved-profile" }));
    const onConnect = vi.fn().mockRejectedValue(new Error("network unavailable"));

    render(
      <QuickConnectModal
        language="zh-CN"
        onClose={vi.fn()}
        onPickKey={async () => ""}
        onSave={onSave}
        onConnect={onConnect}
      />,
    );

    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "example.test" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /保存到服务器列表/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("连接已保存，但连接失败：Error: network unavailable");
  });
});
