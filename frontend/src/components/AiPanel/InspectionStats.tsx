import { useEffect, useRef, useState } from "react";
import { GetAiInspectionStats } from "../../../wailsjs/go/app/App";
import type { InspectionModelStats } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";

// Share of the runs that reached an outcome; stopped runs are excluded.
function share(count: number, row: InspectionModelStats) {
  const counted = row.runs - row.stopped;
  return counted > 0 ? `${count} (${Math.round((count / counted) * 100)}%)` : "0";
}

export function InspectionStats({ locale, onError }: { locale: string; onError: (message: string) => void }) {
  const [rows, setRows] = useState<InspectionModelStats[] | null>(null);
  const [version, setVersion] = useState("all");
  const [batch, setBatch] = useState("all");
  const errorCallback = useRef(onError); errorCallback.current = onError;
  useEffect(() => {
    let disposed = false;
    GetAiInspectionStats()
      .then((values) => { if (!disposed) setRows(values || []); })
      .catch((error) => { if (!disposed) { setRows([]); errorCallback.current(String(error)); } });
    return () => { disposed = true; };
  }, []);
  if (rows === null) return null;
  const versions = [...new Set(rows.map((row) => row.workflowVersion || "legacy"))];
  const batches = [...new Set(rows.map((row) => row.batchId || "single"))];
  const visible = rows.filter((row) => (version === "all" || (row.workflowVersion || "legacy") === version) && (batch === "all" || (row.batchId || "single") === batch));
  return <section className="inspection-evaluation" aria-label={t(locale, "inspectionStats")}>
    <strong>{t(locale, "inspectionStats")}</strong>
    <p>{t(locale, "inspectionStatsNote")}</p>
    {!!rows.length && <div className="ai-inspection-controls">
      <select className="input compact-input" aria-label={t(locale, "inspectionStatsVersionFilter")} value={version} onChange={(e) => setVersion(e.target.value)}><option value="all">{t(locale, "inspectionStatsAll")}</option>{versions.map((value) => <option key={value} value={value}>{value === "legacy" ? t(locale, "inspectionStatsLegacy") : value}</option>)}</select>
      <select className="input compact-input" aria-label={t(locale, "inspectionStatsBatchFilter")} value={batch} onChange={(e) => setBatch(e.target.value)}><option value="all">{t(locale, "inspectionStatsAll")}</option>{batches.map((value) => <option key={value} value={value}>{value === "single" ? t(locale, "inspectionStatsSingle") : value.slice(0, 8)}</option>)}</select>
    </div>}
    {!visible.length ? <p className="inspection-report-empty">{t(locale, "inspectionStatsEmpty")}</p> : <div className="inspection-report-table-wrap"><table>
      <thead><tr>
        <th>{t(locale, "inspectionStatsModel")}</th><th>{t(locale, "inspectionStatsRuns")}</th><th>{t(locale, "inspectionStatsClean")}</th>
        <th>{t(locale, "inspectionStatsCompleted")}</th>
        <th>{t(locale, "inspectionStatsCorrected")}</th><th>{t(locale, "inspectionStatsFailed")}</th><th>{t(locale, "inspectionStatsNoReport")}</th>
        <th>{t(locale, "inspectionStatsFeedback")}</th><th>{t(locale, "inspectionStatsAvgTokens")}</th><th>{t(locale, "inspectionStatsAvgDuration")}</th>
      </tr></thead>
      <tbody>{visible.map((row) => <tr key={[row.provider, row.model, row.workflowVersion, row.promptVersion, row.endpointId, row.reportMode, row.language, row.workflow, row.batchId].join("/")}>
        <th>{row.model || "—"}<br /><small>{row.provider} · {row.workflowVersion || t(locale, "inspectionStatsLegacy")}<br />{row.promptVersion} · {row.reportMode || "—"}<br />{row.language} · {row.workflow} · {row.endpointId}<br />{row.batchId?.slice(0, 8)}</small></th>
        <td>{row.runs}{row.stopped > 0 && <><br /><small>{t(locale, "inspectionStatsStopped").replace("{count}", String(row.stopped))}</small></>}</td>
        <td>{share(row.clean, row)}</td><td>{row.completed === undefined ? "—" : share(row.completed, row)}</td><td>{share(row.corrected, row)}</td><td>{share(row.failed, row)}</td><td>{share(row.noReport, row)}</td>
        <td>{row.falseAlarms} / {row.missedIssues}</td><td>{row.avgTokens}</td><td>{(row.avgDurationMs / 1000).toFixed(1)} s</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
