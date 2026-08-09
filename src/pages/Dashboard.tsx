import { useEffect, useState } from "react";
import { ArrowRight, MonitorSmartphone, Plug, Server, TerminalSquare } from "lucide-react";

import { MetricsView } from "@/components/MetricsView";
import { Button, EmptyState } from "@/components/ui";
import { monitoring } from "@/lib/api";
import { parseSshCommand } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { HostMetrics } from "@/lib/types";

export function Dashboard() {
  const interval = useAppStore((s) => s.settings.metricsInterval);
  const setPage = useAppStore((s) => s.setPage);
  const focusPage = useTabsStore((s) => s.focusPage);
  const openLocal = useTabsStore((s) => s.openLocal);
  const openSsh = useTabsStore((s) => s.openSsh);

  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [quick, setQuick] = useState("");

  // Poll local metrics in a self-rescheduling loop so a transient failure
  // (e.g. running in a plain browser) doesn't kill the timer.
  useEffect(() => {
    let active = true;
    let timer: number;
    const tick = async () => {
      try {
        const m = await monitoring.local();
        if (active) {
          setMetrics(m);
          setError(undefined);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = window.setTimeout(tick, interval);
      }
    };
    tick();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [interval]);

  const connect = () => {
    const p = parseSshCommand(quick);
    if (!p.valid) {
      setError("Could not parse. Try: user@host or host:port");
      return;
    }
    void openSsh(
      {
        hostname: p.hostname,
        port: p.port,
        username: p.username || "root",
        cols: 120,
        rows: 32,
        term: "xterm-256color",
      },
      p.username ? `${p.username}@${p.hostname}` : p.hostname,
    );
    setQuick("");
  };

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Jump into a session or watch this machine's live metrics</p>
        </div>
      </div>

      {/* Quick connect */}
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <TerminalSquare
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
          />
          <input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()}
            placeholder="Quick connect — ssh user@host[:port]"
            className="select-text h-10 w-full rounded-xl border border-border/80 bg-surface pl-9 pr-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <Button variant="primary" onClick={connect} className="h-10 shrink-0">
          Connect <ArrowRight size={14} />
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error.includes("invoke") || error.includes("tauri")
            ? "Local metrics need the desktop runtime. Run with `npm run app:dev`."
            : error}
        </div>
      )}

      {/* Quick actions */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          onClick={() => void openLocal()}
          className="card card-interactive flex items-center gap-3 text-left"
        >
          <span className="icon-chip">
            <MonitorSmartphone size={16} />
          </span>
          <div>
            <p className="text-[13px] font-medium text-fg">Local Shell</p>
            <p className="text-[11px] text-subtle">Open a terminal on this machine</p>
          </div>
        </button>
        <button
          onClick={() => {
            setPage("hosts");
            focusPage();
          }}
          className="card card-interactive flex items-center gap-3 text-left"
        >
          <span className="icon-chip">
            <Server size={16} />
          </span>
          <div>
            <p className="text-[13px] font-medium text-fg">Saved Hosts</p>
            <p className="text-[11px] text-subtle">Manage your connections</p>
          </div>
        </button>
        <button
          onClick={() => {
            setPage("hosts");
            focusPage();
          }}
          className="card card-interactive flex items-center gap-3 text-left"
        >
          <span className="icon-chip">
            <Plug size={16} />
          </span>
          <div>
            <p className="text-[13px] font-medium text-fg">Serial Devices</p>
            <p className="text-[11px] text-subtle">Connect to COM / tty ports</p>
          </div>
        </button>
      </div>

      {metrics ? (
        <MetricsView metrics={metrics} />
      ) : (
        !error && (
          <EmptyState
            icon={<MonitorSmartphone size={28} />}
            title="No metrics yet"
            description="Local system metrics will appear here once the desktop runtime is available."
          />
        )
      )}
    </div>
  );
}
