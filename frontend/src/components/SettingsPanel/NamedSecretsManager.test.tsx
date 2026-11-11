import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteNamedSecret, ListNamedSecrets, SaveNamedSecret } from "../../../wailsjs/go/app/App";
import { NamedSecretsManager } from "./NamedSecretsManager";

vi.mock("../../../wailsjs/go/app/App", () => ({ DeleteNamedSecret: vi.fn(), ListNamedSecrets: vi.fn(), SaveNamedSecret: vi.fn() }));

describe("manual credential vault", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ListNamedSecrets).mockResolvedValue([{ alias: "teldrive-api-hash", reference: "secret://teldrive-api-hash" }]);
    vi.mocked(SaveNamedSecret).mockResolvedValue(undefined);
    vi.mocked(DeleteNamedSecret).mockResolvedValue(undefined);
  });
  it("masks manual input, saves without attributes or settings and clears after save", async () => {
    render(<NamedSecretsManager language="en" />);
    await screen.findByText("secret://teldrive-api-hash");
    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));
    const input = screen.getByLabelText("Secret value") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "teldrive-api-id" } });
    fireEvent.change(input, { target: { value: "test-private-value" } });
    expect(input.getAttribute("value")).toBeNull();
    expect(document.body.textContent).not.toContain("test-private-value");
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(SaveNamedSecret).toHaveBeenCalledWith("teldrive-api-id", "test-private-value", false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(input.value).toBe("");
  });
  it("replaces with a blank masked field and clears cancelled input", async () => {
    render(<NamedSecretsManager language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace credential" }));
    const input = screen.getByLabelText("Secret value") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByLabelText("Credential name")).toBeDisabled();
    fireEvent.change(input, { target: { value: "replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input.value).toBe("");
    expect(SaveNamedSecret).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(SaveNamedSecret).toHaveBeenCalledWith("teldrive-api-hash", "replacement", true));
  });
  it("never displays a raw failed save containing a secret", async () => {
    vi.mocked(SaveNamedSecret).mockRejectedValue(new Error("private-value leaked by bridge"));
    render(<NamedSecretsManager language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace credential" }));
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "private-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private-value");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("requires a delete confirmation and leaves failures visible", async () => {
    vi.mocked(DeleteNamedSecret).mockRejectedValue(new Error("private-value"));
    render(<NamedSecretsManager language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete credential" }));
    expect(DeleteNamedSecret).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete credential" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-value");
    expect(screen.getByText("teldrive-api-hash")).toBeInTheDocument();
    vi.mocked(DeleteNamedSecret).mockResolvedValue(undefined);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete credential" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("copies only the reference", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<NamedSecretsManager language="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy reference" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("secret://teldrive-api-hash"));
  });
  it("shows list errors without treating them as an empty vault", async () => {
    vi.mocked(ListNamedSecrets).mockRejectedValue(new Error("private-value"));
    render(<NamedSecretsManager language="zh-CN" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("凭据列表读取失败");
    expect(screen.getByRole("button", { name: "添加凭据" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("private-value");
  });
});
