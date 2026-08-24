import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-wide error boundary. Without it, a single render-time throw unmounts the
 * whole React tree and the Tauri WebView shows a blank white screen with no
 * clue about what broke. Here we keep the shell alive and show the error + a
 * reload button instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
          <div className="text-[14px] font-semibold text-danger">
            界面出错了 (UI crashed)
          </div>
          <pre className="max-h-[40vh] max-w-2xl overflow-auto rounded-lg border border-border bg-surface p-3 text-left font-mono text-[11px] text-muted">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-medium text-accent-fg transition hover:opacity-90"
          >
            重新加载 (Reload)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
