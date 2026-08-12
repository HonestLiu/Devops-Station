import { useEffect, useMemo, useState } from "react";
import { Activity, Server, Sparkles } from "lucide-react";

import { MetricsView } from "@/components/MetricsView";
import { Button, EmptyState, Select } from "@/components/ui";
import { monitoringInsight } from "@/ai/tasks";
import { monitoring } from "@/lib/api";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { HostMetrics } from "@/lib/types";

export function Monitoring() {
  const t = useT();
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
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("monitoring.title")}</h1>
          <p className="page-subtitle">{t("monitoring.subtitle")}</p>
        </div>
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
              title={t("monitoring.aiInsightTitle")}
              onClick={() => void monitoringInsight(activeSession)}
            >
              <Sparkles size={14} /> {t("monitoring.aiInsight")}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      {sshSessions.length === 0 ? (
        <EmptyState
          icon={<Server size={28} />}
          title={t("monitoring.noSessions")}
          description={t("monitoring.noSessionsHint")}
          action={
            sshHosts.length > 0 ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void openFromHost(sshHosts[0])}
              >
                {t("monitoring.connectHost", { name: sshHosts[0].name })}
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
