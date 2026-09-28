import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsitePanel } from "./WebsitePanel";
import { clearProfileDrafts } from "../../hooks/useProfileDraft";
import type { Tab } from "../../types";

const appMocks = vi.hoisted(() => ({
  getWebsiteStatus: vi.fn(),
  getWebsiteConfig: vi.fn(),
  saveWebsiteConfig: vi.fn(),
  setWebsiteEnabled: vi.fn(),
  deleteWebsite: vi.fn(),
  testWebsiteConfig: vi.fn(),
}));

vi.mock("../../../wailsjs/go/app/App", () => ({
  DeleteWebsite: appMocks.deleteWebsite,
  GetWebsiteConfig: appMocks.getWebsiteConfig,
  GetWebsiteStatus: appMocks.getWebsiteStatus,
  SaveWebsiteConfig: appMocks.saveWebsiteConfig,
  SetWebsiteEnabled: appMocks.setWebsiteEnabled,
  TestWebsiteConfig: appMocks.testWebsiteConfig,
}));

const site = (name: string) => ({
  backend: "nginx",
  mode: "sites",
  name,
  enabled: true,
  serverNames: [name],
  listen: ["80"],
  root: `/var/www/${name}`,
});

const tab = (id: string, profileId = "host-1"): Tab => ({
  id,
  profileId,
  title: "web-01",
  state: "connected",
  type: "ssh",
});

const panel = (active: Tab, onNotify = vi.fn()) => (
  <WebsitePanel active={active} locale="en" onNotify={onNotify} />
);

const configBox = () => document.querySelector(".site-config-input") as HTMLTextAreaElement | null;

// The prompt is portaled out of the render container, and the editor's own
// footer has a "Save" button too, so questions are answered inside the dialog.
const prompt = () => screen.findByRole("dialog", { name: "Save changes?" });

async function answer(label: string) {
  const button = within(await prompt()).getByRole("button", { name: label });
  // The click starts a round trip. Its continuation runs a microtask after
  // fireEvent's own act() scope has closed, so it is awaited inside this one.
  await act(async () => {
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openSite(index = 0) {
  const edits = await screen.findAllByTitle("Edit site");
  fireEvent.click(edits[index]);
  await waitFor(() => expect(configBox()?.value).toBeTruthy());
}

/**
 * A click that starts a round trip leaves state updates behind it (busy flags,
 * the refresh that follows a save). Draining to a macrotask boundary lets them
 * land inside the test instead of after it, which React otherwise reports as an
 * update outside act().
 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  appMocks.getWebsiteStatus.mockResolvedValue({
    sites: [site("example.com")],
    backends: ["nginx:sites"],
    unreadable: 0,
  });
  appMocks.getWebsiteConfig.mockResolvedValue("server {\n    listen 80;\n}\n");
  appMocks.saveWebsiteConfig.mockResolvedValue(undefined);
});

afterEach(() => {
  clearProfileDrafts();
  vi.clearAllMocks();
});

describe("WebsitePanel draft retention", () => {
  it("keeps the draft when another terminal on the same host becomes active", async () => {
    const { rerender } = render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "server { listen 8080; }" } });

    // A second terminal on the same server has a different tab id. The draft
    // belongs to the host, so it must still be there.
    rerender(panel(tab("session-b")));
    await waitFor(() => expect(appMocks.getWebsiteStatus).toHaveBeenCalledTimes(2));
    expect(configBox()?.value).toBe("server { listen 8080; }");
  });

  it("keeps the draft across a drawer switch, which unmounts the panel", async () => {
    const first = render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "server { listen 8080; }" } });
    first.unmount();

    render(panel(tab("session-a")));
    await waitFor(() => expect(configBox()?.value).toBe("server { listen 8080; }"));
  });

  it("does not carry a draft over to a different host", async () => {
    const first = render(panel(tab("session-a", "host-1")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "host one draft" } });
    first.unmount();

    render(panel(tab("session-b", "host-2")));
    await waitFor(() => expect(screen.getAllByTitle("Edit site").length).toBe(1));
    expect(configBox()).toBeNull();
  });
});

describe("WebsitePanel discard prompt", () => {
  it("asks before closing the editor and drops the draft only when told to", async () => {
    render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "changed" } });

    fireEvent.click(screen.getByTitle("Close"));
    expect(configBox()?.value).toBe("changed");

    await answer("Discard");
    await waitFor(() => expect(configBox()).toBeNull());
  });

  it("keeps the draft when the user chooses to keep editing", async () => {
    render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "changed" } });

    fireEvent.click(screen.getByTitle("Close"));
    await answer("Cancel");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(configBox()?.value).toBe("changed");
  });

  it("closes an untouched editor without asking", async () => {
    render(panel(tab("session-a")));
    await openSite();

    fireEvent.click(screen.getByTitle("Close"));
    await waitFor(() => expect(configBox()).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves the draft before carrying out the held action", async () => {
    render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "server { listen 8080; }" } });

    fireEvent.click(screen.getByTitle("Close"));
    await answer("Save");

    await waitFor(() => expect(appMocks.saveWebsiteConfig).toHaveBeenCalledWith(
      "session-a", "nginx", "sites", "example.com", "server { listen 8080; }",
    ));
    await waitFor(() => expect(configBox()).toBeNull());
    // The post-save refresh is a second round trip; let it land inside the test.
    await settle();
    expect(appMocks.getWebsiteStatus).toHaveBeenCalledTimes(2);
  });

  it("asks before loading another site over a dirty draft", async () => {
    appMocks.getWebsiteStatus.mockResolvedValue({
      sites: [site("first.com"), site("second.com")],
      backends: ["nginx:sites"],
      unreadable: 0,
    });
    appMocks.getWebsiteConfig
      .mockResolvedValueOnce("server { first; }")
      .mockResolvedValueOnce("server { second; }");

    render(panel(tab("session-a")));
    await openSite(0);
    fireEvent.change(configBox()!, { target: { value: "dirty" } });

    fireEvent.click(screen.getAllByTitle("Edit site")[1]);
    // Nothing was read: the question comes first.
    expect(appMocks.getWebsiteConfig).toHaveBeenCalledTimes(1);

    await answer("Discard");
    await waitFor(() => expect(configBox()?.value).toBe("server { second; }"));
    await settle();
  });
});
describe("WebsitePanel saves across remounts", () => {
  it("preserves newer draft after an older panel finishes saving", async () => {
    let finish!: () => void;
    appMocks.saveWebsiteConfig.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = render(panel(tab("session-a")));
    await openSite();
    fireEvent.change(configBox()!, { target: { value: "saved snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    first.unmount();
    const second = render(panel(tab("session-b")));
    await waitFor(() => expect(configBox()?.value).toBe("saved snapshot"));
    fireEvent.change(configBox()!, { target: { value: "new unsaved work" } });
    await act(async () => { finish(); });
    second.unmount();
    render(panel(tab("session-b")));
    await settle();
    expect(configBox()?.value).toBe("new unsaved work");
  });
});
