import type { ReactNode } from "react";
import { Activity, Cpu, HardDrive, MemoryStick, Thermometer, Network } from "lucide-react";

import { Bar } from "@/components/ui";
import { formatBytes, formatKb, formatRate, formatUptime } from "@/lib/utils";
import type { HostMetrics } from "@/lib/types";

function StatCard({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2">
        <span className="icon-chip h-7 w-7">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function metricTitle(m: HostMetrics): string {
  return m.hostname || "localhost";
}

export function MetricsView({ metrics }: { metrics: HostMetrics | null }) {
  if (!metrics) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-subtle">
        Gathering metrics…
      </div>
    );
  }

  const memPct = metrics.memTotalKb ? (metrics.memUsedKb / metrics.memTotalKb) * 100 : 0;
  const swapPct = metrics.swapTotalKb ? (metrics.swapUsedKb / metrics.swapTotalKb) * 100 : 0;
  const topProcs = [...metrics.processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);

  return (
    <div className="space-y-4">
      {/* Identity */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold text-fg">{metricTitle(metrics)}</h2>
          <p className="text-[12px] text-muted">
            {metrics.os} · {metrics.kernel}
          </p>
        </div>
        <div className="text-right text-[12px] text-muted">
          <span className="text-subtle">uptime </span>
          {formatUptime(metrics.uptimeSecs)}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {/* CPU */}
        <StatCard icon={<Cpu size={13} />} label="CPU">
          <div className="flex items-baseline justify-between">
            <span className="text-[22px] font-semibold text-fg">
              {metrics.cpuPercent.toFixed(0)}%
            </span>
            <span className="text-[11px] text-subtle">{metrics.cpuCores} cores</span>
          </div>
          <div className="mt-2">
            <Bar value={metrics.cpuPercent} />
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-subtle">
            <span>load 1m {metrics.loadAvg[0].toFixed(2)}</span>
            <span>5m {metrics.loadAvg[1].toFixed(2)}</span>
            <span>15m {metrics.loadAvg[2].toFixed(2)}</span>
          </div>
        </StatCard>

        {/* Memory */}
        <StatCard icon={<MemoryStick size={13} />} label="Memory">
          <div className="flex items-baseline justify-between">
            <span className="text-[22px] font-semibold text-fg">
              {formatKb(metrics.memUsedKb)}
            </span>
            <span className="text-[11px] text-subtle">
              / {formatKb(metrics.memTotalKb)}
            </span>
          </div>
          <div className="mt-2">
            <Bar value={memPct} />
          </div>
          <div className="mt-2 text-[11px] text-subtle">
            swap {formatKb(metrics.swapUsedKb)} / {formatKb(metrics.swapTotalKb)} (
            {swapPct.toFixed(0)}%)
          </div>
        </StatCard>

        {/* Network */}
        <StatCard icon={<Network size={13} />} label="Network">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-subtle">↓ rx</span>
              <span className="font-medium text-success">{formatRate(metrics.netRxBytes)}</span>
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-subtle">↑ tx</span>
              <span className="font-medium text-accent">{formatRate(metrics.netTxBytes)}</span>
            </div>
          </div>
        </StatCard>

        {/* Temperature */}
        <StatCard icon={<Thermometer size={13} />} label="Temperature">
          {metrics.temperatureC != null ? (
            <div className="flex items-baseline gap-1">
              <span className="text-[22px] font-semibold text-fg">
                {metrics.temperatureC.toFixed(0)}
              </span>
              <span className="text-[13px] text-subtle">°C</span>
            </div>
          ) : (
            <p className="text-[12px] text-subtle">No sensor</p>
          )}
        </StatCard>
      </div>

      {/* Disks */}
      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <span className="icon-chip h-7 w-7">
            <HardDrive size={13} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Disks</span>
        </div>
        <div className="space-y-2.5">
          {metrics.disks.map((d) => {
            const pct = d.totalKb ? (d.usedKb / d.totalKb) * 100 : 0;
            return (
              <div key={d.mount} className="text-[12px]">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-fg">{d.mount}</span>
                  <span className="text-subtle">
                    {d.fs} · {formatKb(d.usedKb)} / {formatKb(d.totalKb)}
                  </span>
                </div>
                <Bar value={pct} />
              </div>
            );
          })}
          {metrics.disks.length === 0 && (
            <p className="text-[12px] text-subtle">No disk data</p>
          )}
        </div>
      </div>

      {/* Top processes */}
      {topProcs.length > 0 && (
        <div className="card">
          <div className="mb-3 flex items-center gap-2">
            <span className="icon-chip h-7 w-7">
              <Activity size={13} />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Top Processes
            </span>
          </div>
          <table className="w-full text-[12px]">
            <tbody>
              {topProcs.map((p) => (
                <tr key={p.pid} className="border-b border-border/50 last:border-0">
                  <td className="py-1 pr-2 text-subtle">{p.pid}</td>
                  <td className="max-w-[160px] truncate py-1 pr-2 font-mono text-fg">
                    {p.name}
                  </td>
                  <td className="py-1 text-right text-accent">{p.cpu.toFixed(1)}%</td>
                  <td className="py-1 text-right text-subtle">{formatKb(p.memKb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
