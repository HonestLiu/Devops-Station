import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, ListTree, RefreshCw } from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { serial } from "@/lib/api";
import type { SerialPortInfo } from "@/lib/types";

/** Sentinel option value that switches the picker into free-text mode. */
const CUSTOM = "__custom__";

/** How often to re-enumerate ports so hot-plugged adapters show up on their own. */
const POLL_MS = 2500;

/** Minimum spinner duration for a manual refresh, so the click registers visually. */
const SPIN_MS = 350;

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** Dropdown label, e.g. `COM3 · CP2102 USB to UART Bridge`. */
function portLabel(p: SerialPortInfo): string {
  const desc = p.product ?? p.manufacturer;
  if (desc) return `${p.name} · ${desc}`;
  if (p.kind === "bluetooth") return `${p.name} · Bluetooth`;
  if (p.kind === "usb") return `${p.name} · USB`;
  return p.name;
}

/** Secondary detail line, e.g. `Silicon Labs · 10C4:EA60 · SN 0001`. */
function portDetails(p: SerialPortInfo): string {
  const bits: string[] = [];
  // Only repeat the manufacturer when the label already showed the product.
  if (p.product && p.manufacturer) bits.push(p.manufacturer);
  if (p.vid != null && p.pid != null) bits.push(`${hex4(p.vid)}:${hex4(p.pid)}`);
  if (p.serialNumber) bits.push(`SN ${p.serialNumber}`);
  return bits.join(" · ");
}

/** Cheap structural compare so polling doesn't re-render (and close an open dropdown). */
function sameList(a: SerialPortInfo[], b: SerialPortInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (p, i) =>
      p.name === b[i].name &&
      p.product === b[i].product &&
      p.manufacturer === b[i].manufacturer,
  );
}

/**
 * Serial port selector backed by a live scan of the host's ports.
 *
 * Enumerates on mount and then polls, so plugging in a USB-serial adapter makes it
 * appear without any user action. Falls back to free-text entry for ports that
 * aren't enumerable (or aren't plugged in yet), and never discards a value that
 * came from a saved host just because the device is currently absent.
 */
export function PortPicker({
  value,
  onChange,
  autoSelectFirst = true,
}: {
  value: string;
  onChange: (port: string) => void;
  /** Pick the first detected port when the field starts out empty. */
  autoSelectFirst?: boolean;
}) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [manual, setManual] = useState(false);

  // Read the latest props inside the polling closure without re-creating it.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const autoRef = useRef(autoSelectFirst);
  autoRef.current = autoSelectFirst;

  const scan = useCallback(async (spin = false) => {
    const startedAt = Date.now();
    if (spin) setScanning(true);
    try {
      const list = await serial.listPorts();
      setPorts((prev) => (sameList(prev, list) ? prev : list));
      setError(undefined);
      if (autoRef.current && !valueRef.current.trim() && list.length > 0) {
        onChangeRef.current(list[0].name);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanned(true);
      if (spin) {
        const remaining = SPIN_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        setScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    void scan(true);
    const timer = setInterval(() => void scan(), POLL_MS);
    return () => clearInterval(timer);
  }, [scan]);

  const trimmed = value.trim();
  const selected = ports.find((p) => p.name === value);
  /** A saved port whose device isn't currently connected. */
  const missing = trimmed !== "" && !selected;

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setManual(true);
      return;
    }
    onChange(next);
  };

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      className="h-8 shrink-0 px-2"
      onClick={() => void scan(true)}
      disabled={scanning}
      title={scanned ? `Rescan ports (${ports.length} found)` : "Rescan ports"}
      aria-label="Rescan serial ports"
    >
      <RefreshCw size={13} className={scanning ? "animate-spin" : undefined} />
    </Button>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {manual ? (
          <>
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="COM3 / /dev/ttyUSB0"
              className="select-text font-mono"
              autoFocus
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8 shrink-0 px-2"
              onClick={() => {
                setManual(false);
                void scan(true);
              }}
              title="Back to detected ports"
              aria-label="Back to detected ports"
            >
              <ListTree size={13} />
            </Button>
          </>
        ) : (
          <>
            <Select
              value={missing ? value : selected?.name ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
              className="font-mono"
            >
              {/*
                Must exist whenever the value is empty, otherwise the browser
                displays the first port while the form still holds "".
              */}
              {!trimmed && (
                <option value="">
                  {!scanned
                    ? "Scanning…"
                    : ports.length === 0
                      ? "No ports detected"
                      : "Select a port…"}
                </option>
              )}
              {/* Keep a saved-but-absent port selectable so editing can't drop it. */}
              {missing && <option value={value}>{value} · not connected</option>}
              {ports.map((p) => (
                <option key={p.name} value={p.name}>
                  {portLabel(p)}
                </option>
              ))}
              <option value={CUSTOM}>Enter manually…</option>
            </Select>
            {refreshButton}
          </>
        )}
      </div>

      <PortStatus
        error={error}
        manual={manual}
        missing={missing}
        scanned={scanned}
        selected={selected}
        count={ports.length}
      />
    </div>
  );
}

function PortStatus({
  error,
  manual,
  missing,
  scanned,
  selected,
  count,
}: {
  error?: string;
  manual: boolean;
  missing: boolean;
  scanned: boolean;
  selected?: SerialPortInfo;
  count: number;
}) {
  if (error) {
    return <span className="text-[11px] text-danger">Scan failed: {error}</span>;
  }
  if (manual) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-subtle">
        <Keyboard size={11} />
        Manual entry — {count > 0 ? `${count} port${count > 1 ? "s" : ""} detected` : "no ports detected"}
      </span>
    );
  }
  if (missing) {
    return (
      <span className="text-[11px] text-warning">
        Saved port is not connected right now — it will be used once plugged in.
      </span>
    );
  }
  if (selected) {
    const details = portDetails(selected);
    return (
      <span className="text-[11px] text-subtle">
        {details || `${selected.kind.toUpperCase()} port`}
      </span>
    );
  }
  if (!scanned) {
    return <span className="text-[11px] text-subtle">Scanning for serial ports…</span>;
  }
  if (count === 0) {
    return (
      <span className="text-[11px] text-subtle">
        Plug in a device to auto-detect, or choose “Enter manually…”.
      </span>
    );
  }
  return (
    <span className="text-[11px] text-subtle">
      {count} port{count > 1 ? "s" : ""} detected — select one.
    </span>
  );
}
