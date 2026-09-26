import { Component, type ReactNode } from "react";
import { t } from "../i18n";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      // The app may have crashed before the language setting was read, so
      // fall back to the browser's own language for this last-resort screen.
      const locale = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
      return this.props.fallback || (
        <div role="alert" style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 24, color: "var(--text)", background: "var(--bg)" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{t(locale, "errorBoundaryTitle")}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 520, textAlign: "center", fontFamily: "monospace", overflowWrap: "anywhere" }}>{this.state.error.message}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(this.state.error?.stack || this.state.error?.message || "")}>{t(locale, "errorBoundaryCopyError")}</button>
            <button className="btn-primary" onClick={() => window.location.reload()}>{t(locale, "errorBoundaryReload")}</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
