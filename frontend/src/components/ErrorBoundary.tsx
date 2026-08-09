import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      const zh = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
      return this.props.fallback || (
        <div role="alert" style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 24, color: "var(--text)", background: "var(--bg)" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{zh ? "gxShell 启动失败" : "gxShell could not start"}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", maxWidth: 520, textAlign: "center", fontFamily: "monospace", overflowWrap: "anywhere" }}>{this.state.error.message}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(this.state.error?.stack || this.state.error?.message || "")}>{zh ? "复制错误" : "Copy error"}</button>
            <button className="btn-primary" onClick={() => window.location.reload()}>{zh ? "重新加载" : "Reload"}</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
