import { describe, expect, it } from "vitest";
import { describeTransferConflicts, excludeTransferNames, findTransferConflicts } from "./transferConflict";

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

describe("describeTransferConflicts", () => {
  it("pairs source and destination metadata for the confirmation UI", () => {
    const source = { name: "same.bin", isDir: false, size: 20, modTime: "2026-01-02T03:04:00Z" };
    const destination = { name: "same.bin", isDir: false, size: 10, modTime: "2025-01-02T03:04:00Z" };

    expect(describeTransferConflicts([source], [destination])).toEqual([
      { name: "same.bin", source, destination },
    ]);
  });
});
