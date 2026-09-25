import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronPanel } from "./CronPanel";
import { clearProfileDrafts } from "../../hooks/useProfileDraft";
import type { Tab } from "../../types";

const appMocks = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  saveCronJob: vi.fn(),
  setCronJobEnabled: vi.fn(),
  runCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
}));

vi.mock("../../../wailsjs/go/app/App", () => ({
  DeleteCronJob: appMocks.deleteCronJob,
  ListCronJobs: appMocks.listCronJobs,
  RunCronJob: appMocks.runCronJob,
  SaveCronJob: appMocks.saveCronJob,
  SetCronJobEnabled: appMocks.setCronJobEnabled,
}));

const job = {
  id: "job-1",
  schedule: "0 3 * * *",
  command: "/usr/local/bin/backup.sh",
  enabled: true,
};

const tab = (id: string, profileId = "host-1"): Tab => ({
  id,
  profileId,
  title: "web-01",
  state: "connected",
  type: "ssh",
});

const panel = (active: Tab) => <CronPanel active={active} locale="en" onNotify={vi.fn()} />;

const commandBox = () =>
  document.querySelector(".admin-command-input") as HTMLTextAreaElement | null;

async function openJob() {
  fireEvent.click(await screen.findByTitle("Edit task"));
  await waitFor(() => expect(commandBox()?.value).toBe(job.command));
}

beforeEach(() => {
  appMocks.listCronJobs.mockResolvedValue([job]);
  appMocks.saveCronJob.mockResolvedValue(undefined);
});

afterEach(() => {
  clearProfileDrafts();
  vi.clearAllMocks();
});

describe("CronPanel draft retention", () => {
  it("keeps the draft when another terminal on the same host becomes active", async () => {
    const { rerender } = render(panel(tab("session-a")));
    await openJob();
    fireEvent.change(commandBox()!, { target: { value: "/opt/new-backup.sh" } });

    rerender(panel(tab("session-b")));
    await waitFor(() => expect(appMocks.listCronJobs).toHaveBeenCalledTimes(2));
    expect(commandBox()?.value).toBe("/opt/new-backup.sh");
  });

  it("keeps the draft across a drawer switch, which unmounts the panel", async () => {
    const first = render(panel(tab("session-a")));
    await openJob();
    fireEvent.change(commandBox()!, { target: { value: "/opt/new-backup.sh" } });
    first.unmount();

    render(panel(tab("session-a")));
    await waitFor(() => expect(commandBox()?.value).toBe("/opt/new-backup.sh"));
  });
});

describe("CronPanel discard prompt", () => {
  it("asks before closing a dirty draft, and closes only when told to", async () => {
    render(panel(tab("session-a")));
    await openJob();
    fireEvent.change(commandBox()!, { target: { value: "/opt/new-backup.sh" } });

    fireEvent.click(screen.getByTitle("Close"));
    expect(commandBox()?.value).toBe("/opt/new-backup.sh");

    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(commandBox()).toBeNull());
  });

  it("closes an untouched draft without asking", async () => {
    render(panel(tab("session-a")));
    await openJob();

    fireEvent.click(screen.getByTitle("Close"));
    await waitFor(() => expect(commandBox()).toBeNull());
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("keeps the draft when the user chooses to keep editing", async () => {
    render(panel(tab("session-a")));
    await openJob();
    fireEvent.change(commandBox()!, { target: { value: "/opt/new-backup.sh" } });

    fireEvent.click(screen.getByTitle("Close"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());
    expect(commandBox()?.value).toBe("/opt/new-backup.sh");
  });
});
