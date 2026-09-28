import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ListRemoteDir } from "../../wailsjs/go/app/App";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";
import { useSftp } from "./useSftp";

vi.mock("../../wailsjs/go/app/App", () => ({ ListRemoteDir: vi.fn() }));
const list = vi.mocked(ListRemoteDir);
const tab = (id: string): Tab => ({ id, profileId: id, title: id, state: "connected" });
const files = (name: string) => [new types.RemoteFile({ name, isDir: true })];
beforeEach(() => { vi.restoreAllMocks(); list.mockReset(); list.mockResolvedValue(files("home")); });

it("reuses recent listings and remembers each server's directory", async () => {
  const { result, rerender } = renderHook(({ id, drawer }) => useSftp(tab(id), drawer), { initialProps: { id: "a", drawer: "sftp" } });
  await waitFor(() => expect(result.current.sftpBusy).toBe(false));
  await act(async () => { await result.current.refreshSftp("/etc"); });
  rerender({ id: "a", drawer: "monitor" });
  rerender({ id: "a", drawer: "sftp" });
  expect(list).toHaveBeenCalledTimes(2);
  rerender({ id: "b", drawer: "sftp" });
  await waitFor(() => expect(result.current.sftpBusy).toBe(false));
  rerender({ id: "a", drawer: "sftp" });
  expect(result.current.remotePath).toBe("/etc");
  expect(list).toHaveBeenCalledTimes(3);
});

it("keeps cached rows visible during a stale refresh and handles failure", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const notify = vi.fn();
  const { result, rerender } = renderHook(({ drawer }) => useSftp(tab("a"), drawer, notify), { initialProps: { drawer: "sftp" } });
  await waitFor(() => expect(result.current.remoteFiles).toHaveLength(1));
  now.mockReturnValue(16_000);
  let reject!: (error: Error) => void;
  list.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  rerender({ drawer: "monitor" });
  rerender({ drawer: "sftp" });
  expect(result.current.sftpBusy).toBe(true);
  expect(result.current.remoteFiles[0].name).toBe("home");
  await act(async () => { reject(new Error("offline")); });
  expect(result.current.sftpBusy).toBe(false);
  expect(result.current.remoteFiles[0].name).toBe("home");
  expect(notify).toHaveBeenCalledWith("Error: offline", "error");
});

it("forces explicit refresh and invalidates other cached folders after mutations", async () => {
  const { result } = renderHook(() => useSftp(tab("a"), "sftp"));
  await waitFor(() => expect(result.current.remoteFiles).toHaveLength(1));
  await act(async () => { await result.current.refreshSftp("/etc"); });
  await act(async () => { await result.current.refreshSftp(); });
  await act(async () => { await result.current.refreshSftp("."); });
  expect(list).toHaveBeenCalledTimes(4);
});

it("deduplicates pending loads and never publishes a different server's files", async () => {
  let resolve!: (value: types.RemoteFile[]) => void;
  list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ id, drawer }) => useSftp(tab(id), drawer), { initialProps: { id: "a", drawer: "sftp" } });
  rerender({ id: "a", drawer: "monitor" });
  rerender({ id: "a", drawer: "sftp" });
  expect(list).toHaveBeenCalledTimes(1);
  rerender({ id: "b", drawer: "sftp" });
  await waitFor(() => expect(result.current.remoteFiles[0]?.name).toBe("home"));
  await act(async () => { resolve(files("server-a")); });
  expect(result.current.remoteFiles[0].name).toBe("home");
});

it("does not let a pre-mutation request replace a forced refresh", async () => {
  let resolve!: (value: types.RemoteFile[]) => void;
  list.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ drawer }) => useSftp(tab("a"), drawer), { initialProps: { drawer: "sftp" } });
  await act(async () => { await result.current.refreshSftp(); });
  await act(async () => { resolve(files("deleted-file")); });
  rerender({ drawer: "monitor" });
  rerender({ drawer: "sftp" });
  expect(result.current.remoteFiles[0].name).toBe("home");
  expect(list).toHaveBeenCalledTimes(2);
});
