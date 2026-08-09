import { useEffect, useMemo, useState } from "react";
import { Activity, Server, Sparkles } from "lucide-react";

import { MetricsView } from "@/components/MetricsView";
import { Button, EmptyState, Select } from "@/components/ui";
import { monitoringInsight } from "@/ai/tasks";
import { monitoring } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { HostMetrics } from "@/lib/types";

export function Monitoring() {
  const interval = useAppStore((s) => s.settings.metricsInterval);
  const hosts = useHostsStore((s) => s.hosts);
  const tabs = useTabsStore((s) => s.tabs);
  const openFromHost = useTabsStore((s) => s.openFromHost);

  // Connected SSH sessions are the only things we can probe remotely.
  const sshSessions = useMemo(
    () =>
      tabs.filter((t) => t.kind === "ssh" && t.status === "connected" && t.sessionId),
    [tabs],
  );

  const [selected, setSelected] = useState<string | undefined>();
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [error, setError] = useState<string | undefined>();

  const activeSession = selected ?? sshSessions[0]?.sessionId;

  useEffect(() => {
    if (!activeSession) {
      setMetrics(null);
      return;
    }
    let active = true;
    let timer: number;
    const tick = async () => {
      try {
        const m = await monitoring.remote(activeSession);
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
  }, [activeSession, interval]);

  const sshHosts = hosts.filter((h) => h.kind === "ssh");

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-semibold text-fg">Monitoring</h1>
        {sshSessions.length > 0 && (
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-subtle" />
            <Select
              value={activeSession ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              className="w-64"
            >
              {sshSessions.map((t) => (
                <option key={t.id} value={t.sessionId}>
                  {t.title}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              size="sm"
              title="Ask the AI to interpret the current metrics"
              onClick={() => void monitoringInsight(activeSession)}
            >
              <Sparkles size={14} /> AI Insight
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {sshSessions.length === 0 ? (
        <EmptyState
          icon={<Server size={28} />}
          title="No active SSH sessions"
          description="Open an SSH connection first, then return here to watch its live CPU, memory, disk, network, and temperature."
          action={
            sshHosts.length > 0 ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void openFromHost(sshHosts[0])}
              >
                Connect {sshHosts[0].name}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <MetricsView metrics={metrics} />
      )}
    </div>
  );
}
