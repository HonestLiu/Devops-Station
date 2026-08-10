import { useEffect, useMemo, useState } from "react";
import {
  Cable,
  Pencil,
  Plus,
  TerminalSquare,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge, Button, EmptyState, Field, Select } from "@/components/ui";
import { PortPicker } from "@/components/serial/PortPicker";
import { HostDialog } from "@/components/HostDialog";
import { hashColor } from "@/lib/utils";
import { serial } from "@/lib/api";
import { useHostsStore, emptyHost } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { Host } from "@/lib/types";

/** Used until the backend's canonical list arrives (and if that call ever fails). */
const FALLBACK_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function SerialPage() {
  const hosts = useHostsStore((s) => s.hosts);
  const deleteHost = useHostsStore((s) => s.deleteHost);
  const openFromHost = useTabsStore((s) => s.openFromHost);
  const openSerial = useTabsStore((s) => s.openSerial);

  const serialHosts = useMemo(
    () => hosts.filter((h) => h.kind === "serial"),
    [hosts],
  );

  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);

  // ---- Quick connect (ad-hoc: open a port without saving a host) ----------
  const [port, setPort] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [baudRates, setBaudRates] = useState<number[]>(FALLBACK_BAUD_RATES);

  useEffect(() => {
    let alive = true;
    serial
      .baudRates()
      .then((rates) => {
        if (alive && rates.length > 0) setBaudRates(rates);
      })
      .catch(() => {
        /* keep the fallback list */
      });
    return () => {
      alive = false;
    };
  }, []);

  const baudOptions = useMemo(() => {
    return baudRates.includes(baudRate)
      ? baudRates
      : [...baudRates, baudRate].sort((a, b) => a - b);
  }, [baudRates, baudRate]);

  const openQuick = () => {
    if (!port.trim()) return;
    void openSerial(
      {
        port: port.trim(),
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      },
      port.trim(),
    );
  };

  const connect = (h: Host) => void openFromHost(h);

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Serial</h1>
          <p className="page-subtitle">
            Serial consoles — open a port directly or a saved device
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreating(true)}
          >
            <Plus size={14} /> New serial host
          </Button>
        </div>
      </div>

      {/* Quick connect */}
      <div className="card mb-5 p-4">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
          <TerminalSquare size={15} className="text-accent" />
          Quick connect
          <span className="text-[11px] font-normal text-subtle">
            opens a console without saving a host
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Port" className="min-w-[240px] flex-1">
            <PortPicker value={port} onChange={setPort} autoSelectFirst />
          </Field>
          <Field label="Baud rate" className="w-36" hint={" "}>
            <Select
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
            >
              {baudOptions.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            onClick={openQuick}
            disabled={!port.trim()}
            className="mb-[1px]"
          >
            <Cable size={14} /> Open console
          </Button>
        </div>
      </div>

      {/* Saved serial hosts */}
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-fg">Saved serial hosts</h2>
        <Badge tone="warning">{serialHosts.length}</Badge>
      </div>

      {serialHosts.length === 0 ? (
        <EmptyState
          icon={<Cable size={28} />}
          title="No serial hosts yet"
          description="Add a serial host to keep its port, baud and settings, or use Quick connect above."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> New serial host
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {serialHosts.map((h) => {
            const color = h.color || hashColor(h.name);
            const subtitle = `${h.serialPort ?? "?"} · ${h.baudRate ?? 115200} baud`;
            return (
              <div key={h.id} className="card card-interactive group flex flex-col">
                <div className="mb-3 flex items-center gap-2.5">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold text-accent-fg"
                    style={{ backgroundColor: color }}
                  >
                    {h.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                    {h.name}
                  </span>
                  <Badge tone="warning">Serial</Badge>
                </div>
                <div className="mb-3 flex items-center gap-1.5 text-[12px] text-muted">
                  <Cable size={13} className="shrink-0 text-subtle" />
                  <span className="truncate">{subtitle}</span>
                </div>

                {h.tags && h.tags.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {h.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-subtle"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1.5">
                  <Button
                    variant="primary"
                    size="sm"
                    className="flex-1"
                    onClick={() => connect(h)}
                  >
                    Connect
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(h)}
                    title="Edit"
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Delete serial host "${h.name}"?`))
                        void deleteHost(h.id);
                    }}
                    title="Delete"
                  >
                    <Trash2 size={13} className="text-danger" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <HostDialog
          initial={emptyHost("serial")}
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
      {editing && (
        <HostDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}
