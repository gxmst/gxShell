import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransferModal } from "./TransferModal";

const appMocks = vi.hoisted(() => ({
  localHomeDir: vi.fn(),
  listLocalDir: vi.fn(),
  listRemoteDir: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../../../wailsjs/go/app/App", () => ({
  CancelTransfer: vi.fn(),
  PauseTransfer: vi.fn(),
  ResumeTransfer: vi.fn(),
  LocalHomeDir: appMocks.localHomeDir,
  ListLocalDir: appMocks.listLocalDir,
  ListRemoteDir: appMocks.listRemoteDir,
  UploadFileWithPolicy: appMocks.uploadFile,
  DownloadFileWithPolicy: appMocks.downloadFile,
}));

describe("TransferModal conflict context", () => {
  beforeEach(() => {
    appMocks.localHomeDir.mockResolvedValue("C:/local");
    appMocks.listLocalDir.mockResolvedValue([
      { name: "same.txt", path: "C:/local/same.txt", size: 5, isDir: false },
    ]);
    appMocks.listRemoteDir.mockResolvedValue([
      { name: "same.txt", path: "/same.txt", size: 3, mode: "-rw-r--r--", modTime: "", isDir: false },
    ]);
    appMocks.uploadFile.mockReset();
    appMocks.downloadFile.mockReset();
  });

  it("cannot apply session A's overwrite confirmation after switching to session B", async () => {
    const { rerender } = render(
      <TransferModal active={{ id: "session-a" }} locale="en" onClose={vi.fn()} />,
    );

    const panels = document.querySelectorAll<HTMLElement>(".transfer-panel");
    expect(panels).toHaveLength(2);
    const localName = await within(panels[0]).findByText("same.txt");
    fireEvent.click(localName.closest(".transfer-file-item")!);
    fireEvent.click(screen.getByTitle("Upload"));

    const staleOverwrite = await screen.findByRole("button", { name: "Overwrite all" });
    expect(appMocks.uploadFile).not.toHaveBeenCalled();

    rerender(
      <TransferModal active={{ id: "session-b" }} locale="en" onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Overwrite all" })).not.toBeInTheDocument();
    });

    // Keep a reference to the button from session A and try to dispatch the old
    // action after the rerender. Neither session may receive that stale intent.
    fireEvent.click(staleOverwrite);
    expect(appMocks.uploadFile).not.toHaveBeenCalled();
    expect(appMocks.downloadFile).not.toHaveBeenCalled();
  });
});
