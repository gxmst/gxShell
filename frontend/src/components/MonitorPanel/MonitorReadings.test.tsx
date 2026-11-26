import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { ConnectionQuality, LoadAverages } from "./MonitorReadings";

it("counts unanswered probes, excludes unavailable probes and uses the latest reply for latency", () => {
  const probeHistory = ["unavailable", "lost", "reply", "reply", "reply"].map(state => ({
    state, method: "icmp", at: "2026-11-26T09:00:00Z", rttMs: 18,
  }));
  const { rerender } = render(<ConnectionQuality lang="zh-CN" metrics={new types.Metrics({ latencyMs: 806, probeHistory })} />);
  expect(screen.getByText("25.0%")).toBeInTheDocument();
  expect(screen.getByText("18 ms")).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAccessibleName(/已探测 4 次，其中 1 次无响应/);
  rerender(<ConnectionQuality lang="zh-CN" metrics={new types.Metrics({ probeHistory: [{ state: "lost", method: "ssh" }] })} />);
  expect(screen.getByText("无响应")).toBeInTheDocument();
  expect(screen.getByText("100.0%")).toBeInTheDocument();
  expect(screen.getByText("探测失败率")).toBeInTheDocument();
  rerender(<ConnectionQuality lang="zh-CN" />);
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("labels each load window and distinguishes a missing reading from zero", () => {
  render(<LoadAverages lang="zh-CN" metrics={new types.Metrics({ loadAverage: "0.00 1.23", cpuCount: 4 })} />);
  for (const [label, value] of [["1 分钟", "0.00"], ["5 分钟", "1.23"], ["15 分钟", "—"]]) {
    expect(screen.getByText(label).parentElement).toHaveTextContent(value);
  }
  expect(screen.getByText("4 个逻辑核")).toBeInTheDocument();
});
