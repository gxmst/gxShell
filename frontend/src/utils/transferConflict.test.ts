import { describe, expect, it } from "vitest";
import { excludeTransferNames, findTransferConflicts } from "./transferConflict";

describe("findTransferConflicts", () => {
  it("separates replaceable files from directory collisions", () => {
    const sources = [
      { name: "one.txt", isDir: false },
      { name: "folder.txt", isDir: false },
      { name: "new.txt", isDir: false },
    ];
    const destinations = [
      { name: "one.txt", isDir: false },
      { name: "folder.txt", isDir: true },
    ];

    expect(findTransferConflicts(sources, destinations)).toEqual({
      replaceable: ["one.txt"],
      directories: ["folder.txt"],
    });
  });

  it("matches local Windows names without case sensitivity", () => {
    const sources = [{ name: "README.md", isDir: false }];
    const destinations = [{ name: "readme.MD", isDir: false }];

    expect(findTransferConflicts(sources, destinations, true).replaceable).toEqual(["README.md"]);
    expect(findTransferConflicts(sources, destinations, false).replaceable).toEqual([]);
  });
});

describe("excludeTransferNames", () => {
  it("uses the same case policy as conflict detection", () => {
    const sources = [
      { name: "README.md", isDir: false },
      { name: "notes.md", isDir: false },
    ];

    expect(excludeTransferNames(sources, ["readme.md"], true)).toEqual([sources[1]]);
    expect(excludeTransferNames(sources, ["readme.md"], false)).toEqual(sources);
  });
});
