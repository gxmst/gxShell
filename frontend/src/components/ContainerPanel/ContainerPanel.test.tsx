import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { ContainerPanel } from "./ContainerPanel";

// These panels issue commands against one SSH session and then write the reply
// back into their own state. The panel can be pointed at another host while a
// command is in flight, and that reply describes the host it was sent to — so
// it must not repaint the list of the host now on screen.

const appMocks = vi.hoisted(() => ({
  listContainers: vi.fn(),
  restartContainer: vi.fn(),
  stopContainer: vi.fn(),
  startContainer: vi.fn(),
  removeContainer: vi.fn(),
  streamContainerLogs: vi.fn(),
  stopContainerLogs: vi.fn(),
}));

vi.mock("../../../wailsjs/go/app/App", () => ({
  ListContainers: appMocks.listContainers,
  RestartContainer: appMocks.restartContainer,
  StopContainer: appMocks.stopContainer,
  StartContainer: appMocks.startContainer,
  RemoveContainer: appMocks.removeContainer,
  StreamContainerLogs: appMocks.streamContainerLogs,
  StopContainerLogs: appMocks.stopContainerLogs,
}));

vi.mock("../../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn(() => () => undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function container(id: string, state = "running") {
  return new types.ContainerInfo({
    id,
    names: [`app-${id}`],
    image: "nginx:alpine",
    state,
    status: state === "running" ? "Up 2 hours" : "Exited (0) 3 minutes ago",
    ports: "",
    created: 0,
  });
}

function sshTab(id: string): any {
  return { id, profileId: `profile-${id}`, title: id, state: "connected", type: "ssh" };
}

describe("ContainerPanel session scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMocks.listContainers.mockResolvedValue([]);
  });

  it("does not show the previous host's containers once another is on screen", async () => {
    const first = deferred<types.ContainerInfo[]>();
    const second = deferred<types.ContainerInfo[]>();
    appMocks.listContainers.mockImplementation((sessionId: string) => (
      sessionId === "session-a" ? first.promise : second.promise
    ));

    const { rerender } = render(
      <ContainerPanel active={sshTab("session-a")} locale="en" onNotify={vi.fn()} />,
    );
    rerender(<ContainerPanel active={sshTab("session-b")} locale="en" onNotify={vi.fn()} />);

    await act(async () => { second.resolve([container("b1")]); });
    expect(await screen.findByText("app-b1")).toBeInTheDocument();

    // The first host's reply lands afterwards. It used to overwrite the list.
    await act(async () => { first.resolve([container("a1")]); });
    expect(screen.queryByText("app-a1")).not.toBeInTheDocument();
    expect(screen.getByText("app-b1")).toBeInTheDocument();
  });

  it("does not report an action started on the previous host", async () => {
    const removal = deferred<unknown>();
    appMocks.listContainers.mockResolvedValue([container("a1", "exited")]);
    appMocks.removeContainer.mockReturnValue(removal.promise);

    const onNotify = vi.fn();
    const { rerender } = render(
      <ContainerPanel active={sshTab("session-a")} locale="en" onNotify={onNotify} />,
    );

    // Removal is two-step: arm, then execute within three seconds.
    const remove = await screen.findByTitle("Remove");
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(appMocks.removeContainer).toHaveBeenCalledWith("session-a", "a1", true));

    rerender(<ContainerPanel active={sshTab("session-b")} locale="en" onNotify={onNotify} />);
    await act(async () => { removal.resolve(undefined); });

    expect(onNotify).not.toHaveBeenCalled();
  });

  // The sidebar keys this panel by session, so switching hosts unmounts this
  // instance and mounts another. `viewLogs` awaits a round trip before opening
  // the stream, and the guard it used was a render-time ref — which the
  // unmounted copy keeps frozen at the old id, so the guard always passed. The
  // old instance then opened a `docker logs -f` on the host the user had just
  // left, and nothing was ever going to stop it: the unmount cleanup had already
  // run before the new stream id was assigned.
  it("does not open a log stream on the host it was remounted away from", async () => {
    appMocks.listContainers.mockResolvedValue([container("a1")]);
    appMocks.streamContainerLogs.mockResolvedValue(undefined);
    const stopping = deferred<unknown>();
    appMocks.stopContainerLogs.mockReturnValue(stopping.promise);

    const view = (sessionId: string) => (
      <ContainerPanel key={sessionId} active={sshTab(sessionId)} locale="en" onNotify={vi.fn()} />
    );
    const { rerender } = render(view("session-a"));

    const logs = await screen.findByTitle("View logs");
    // The first click has no previous stream, so it opens one straight away.
    fireEvent.click(logs);
    await waitFor(() => expect(appMocks.streamContainerLogs).toHaveBeenCalledTimes(1));
    expect(appMocks.streamContainerLogs.mock.calls[0][0]).toBe("session-a");

    // The second click stops the stream it is replacing. That stop is the round
    // trip the panel can be remounted during.
    fireEvent.click(logs);
    await waitFor(() => expect(appMocks.stopContainerLogs).toHaveBeenCalledTimes(1));

    rerender(view("session-b"));
    await act(async () => { stopping.resolve(undefined); });

    expect(appMocks.streamContainerLogs).toHaveBeenCalledTimes(1);
  });

  it("still reports an action that completes on the host on screen", async () => {
    appMocks.listContainers.mockResolvedValue([container("a1", "exited")]);
    appMocks.removeContainer.mockResolvedValue(undefined);

    const onNotify = vi.fn();
    render(<ContainerPanel active={sshTab("session-a")} locale="en" onNotify={onNotify} />);

    const remove = await screen.findByTitle("Remove");
    fireEvent.click(remove);
    fireEvent.click(remove);

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("app-a1: removed", "success"));
  });

  it("counts the containers in the panel locale", async () => {
    appMocks.listContainers.mockResolvedValue([container("a1"), container("a2")]);

    render(<ContainerPanel active={sshTab("session-a")} locale="zh-CN" onNotify={vi.fn()} />);

    expect(await screen.findByText("2 个容器")).toBeInTheDocument();
  });

  it("treats a local terminal as no session at all", async () => {
    // A local terminal tab carries `local: true` and an empty profileId; it has
    // no remote session behind it, so there is nothing to list. Without the gate
    // this polled the tab id every 10s and toasted "session not found".
    render(
      <ContainerPanel
        active={{ id: "local-1", profileId: "", title: "Local Terminal", state: "connected", local: true } as any}
        locale="en"
        onNotify={vi.fn()}
      />,
    );
    expect(screen.getByText("No active session")).toBeInTheDocument();
    expect(appMocks.listContainers).not.toHaveBeenCalled();
  });
});
