import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ILink } from "@xterm/xterm";
import { createLinkProvider } from "./terminalLinks";

const terminals: Terminal[] = [];
afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()));

async function makeTerminal(text: string, cols = 80, rows = 4) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  terminals.push(terminal);
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  return terminal;
}

function linksAt(terminal: Terminal, row: number) {
  let links: ILink[] | undefined;
  createLinkProvider(terminal, { openUrl: vi.fn(), openPath: vi.fn() })
    .provideLinks(row, (result) => { links = result; });
  return links || [];
}

describe("terminal link buffer coordinates", () => {
  it("keeps links aligned after output creates scrollback", async () => {
    const terminal = await makeTerminal("padding\r\n".repeat(12) + "https://example.com");
    expect(terminal.buffer.active.viewportY).toBeGreaterThan(0);
    const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY + 1;
    expect(linksAt(terminal, row)).toMatchObject([
      { text: "https://example.com", range: { start: { x: 1, y: row } } },
    ]);
  });

  it("finds a wrapped link when hovering its continuation row", async () => {
    const url = "https://example.com/path";
    const terminal = await makeTerminal(url, 12);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(linksAt(terminal, 2)).toMatchObject([
      { text: url, range: { start: { x: 1, y: 1 }, end: { x: url.length - 12, y: 2 } } },
    ]);
  });

  it.each([
    ["\u4e2d\u6587 ", 6],
    ["e\u0301 ", 3],
    ["\ud83d\ude00 ", 4],
  ])("uses cell positions after %s", async (prefix, start) => {
    const terminal = await makeTerminal(`${prefix}https://example.com`);
    expect(linksAt(terminal, 1)[0]?.range.start).toEqual({ x: start, y: 1 });
  });

  it("retains wide characters that wrap after an unused cell", async () => {
    const url = "https://a/\u4e2d";
    const terminal = await makeTerminal(url, 11);
    expect(linksAt(terminal, 2)).toMatchObject([
      { text: url, range: { start: { x: 1, y: 1 }, end: { x: 2, y: 2 } } },
    ]);
  });

  it("routes URLs and paths and honors the enabled setting", async () => {
    const terminal = await makeTerminal("https://example.com /etc/nginx/nginx.conf");
    const handlers = { openUrl: vi.fn(), openPath: vi.fn() };
    let enabled = true;
    const provider = createLinkProvider(terminal, handlers, () => enabled);
    let links: ILink[] = [];
    provider.provideLinks(1, (result) => { links = result || []; });
    links.forEach((link) => link.activate(new MouseEvent("click"), link.text));
    expect(handlers.openUrl).toHaveBeenCalledWith("https://example.com");
    expect(handlers.openPath).toHaveBeenCalledWith("/etc/nginx/nginx.conf");
    enabled = false;
    provider.provideLinks(1, (result) => expect(result).toBeUndefined());
  });
});
