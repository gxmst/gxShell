import { beforeEach, describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { detectOsFromText, detectServerOs, getStoredServerOs, saveStoredServerOs } from "./ServerOsIcon";

describe("ServerOsIcon detection", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  it("detects explicit os: tag", () => {
    const profile = new types.Profile({
      name: "node-1",
      tags: ["prod", "os:ubuntu"],
    });
    expect(detectServerOs(profile)).toBe("ubuntu");
  });

  it("detects os from plain tags", () => {
    expect(detectServerOs(new types.Profile({ tags: ["debian"] }))).toBe("debian");
    expect(detectServerOs(new types.Profile({ tags: ["centos"] }))).toBe("centos");
    expect(detectServerOs(new types.Profile({ tags: ["alpine"] }))).toBe("alpine");
    expect(detectServerOs(new types.Profile({ tags: ["arch"] }))).toBe("arch");
    expect(detectServerOs(new types.Profile({ tags: ["windows"] }))).toBe("windows");
    expect(detectServerOs(new types.Profile({ tags: ["docker"] }))).toBe("docker");
  });

  it("detects os from banner / MOTD text", () => {
    const debianBanner = "Linux Kvm-20250428-JXE 6.12.74+deb13+1-cloud-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.12.74-2 (2026-03-08) x86_64";
    expect(detectOsFromText(debianBanner)).toBe("debian");

    const ubuntuBanner = "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-105-generic x86_64)";
    expect(detectOsFromText(ubuntuBanner)).toBe("ubuntu");

    const alpineBanner = "Welcome to Alpine Linux 3.19";
    expect(detectOsFromText(alpineBanner)).toBe("alpine");

    expect(detectOsFromText('NAME="Rocky Linux"\nID_LIKE="rhel centos fedora"')).toBe("rocky");
    expect(detectOsFromText('NAME="AlmaLinux"\nID_LIKE="rhel centos fedora"')).toBe("rocky");
  });

  it("prioritizes runtimeOs over name keywords", () => {
    const profile = new types.Profile({ id: "p1", name: "tx1", host: "144.48.4.65" });
    expect(detectServerOs(profile)).toBe("server");
    expect(detectServerOs(profile, "debian")).toBe("debian");
  });

  it("persists detected OS to localStorage", () => {
    saveStoredServerOs("p1", "debian");
    expect(getStoredServerOs("p1")).toBe("debian");

    const profile = new types.Profile({ id: "p1", name: "tx1", host: "144.48.4.65" });
    expect(detectServerOs(profile)).toBe("debian");
  });
});
