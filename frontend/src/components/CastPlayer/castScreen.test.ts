import { expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { CastScreen } from "./castScreen";

it("resizes only after preceding output was parsed and restores the original grid on seek", () => {
  let parsed = () => {};
  const calls: string[] = [];
  const term = {
    write: (text: string, done: () => void) => { calls.push(text); parsed = done; },
    resize: (w: number, h: number) => calls.push(w + "x" + h),
    reset: () => calls.push("reset"),
  };
  const screen = new CastScreen(term as unknown as Terminal, { width: 100, height: 32 }, [
    { time: 0, code: "o", data: "first" }, { time: 1, code: "r", data: "160x50" }, { time: 2, code: "o", data: "last" },
  ]);
  screen.show(3);
  expect(calls).toEqual(["first"]);
  parsed();
  expect(calls).toEqual(["first", "160x50", "last"]);
  screen.show(1, true);
  parsed();
  expect(calls.slice(-3)).toEqual(["reset", "100x32", "first"]);
});
