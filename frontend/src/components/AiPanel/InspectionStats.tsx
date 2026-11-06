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
  const errorCallback = useRef(onError); errorCallback.current = onError;
  useEffect(() => {
    let disposed = false;
    GetAiInspectionStats()
      .then((values) => { if (!disposed) setRows(values || []); })
      .catch((error) => { if (!disposed) { setRows([]); errorCallback.current(String(error)); } });
    return () => { disposed = true; };
  }, []);
  if (rows === null) return null;
  return <section className="inspection-evaluation" aria-label={t(locale, "inspectionStats")}>
    <strong>{t(locale, "inspectionStats")}</strong>
    <p>{t(locale, "inspectionStatsNote")}</p>
    {!rows.length ? <p className="inspection-report-empty">{t(locale, "inspectionStatsEmpty")}</p> : <div className="inspection-report-table-wrap"><table>
      <thead><tr>
        <th>{t(locale, "inspectionStatsModel")}</th><th>{t(locale, "inspectionStatsRuns")}</th><th>{t(locale, "inspectionStatsClean")}</th>
        <th>{t(locale, "inspectionStatsCorrected")}</th><th>{t(locale, "inspectionStatsFailed")}</th><th>{t(locale, "inspectionStatsNoReport")}</th>
        <th>{t(locale, "inspectionStatsFeedback")}</th><th>{t(locale, "inspectionStatsAvgTokens")}</th><th>{t(locale, "inspectionStatsAvgDuration")}</th>
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.provider}/${row.model}`}>
        <th>{row.model || "—"}<br /><small>{row.provider}</small></th>
        <td>{row.runs}{row.stopped > 0 && <><br /><small>{t(locale, "inspectionStatsStopped").replace("{count}", String(row.stopped))}</small></>}</td>
        <td>{share(row.clean, row)}</td><td>{share(row.corrected, row)}</td><td>{share(row.failed, row)}</td><td>{share(row.noReport, row)}</td>
        <td>{row.falseAlarms} / {row.missedIssues}</td><td>{row.avgTokens}</td><td>{(row.avgDurationMs / 1000).toFixed(1)} s</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
