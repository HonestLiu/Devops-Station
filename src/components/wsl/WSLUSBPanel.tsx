import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Usb as UsbIcon, X } from "lucide-react";

import { Button, SideIconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { usb, wsl } from "@/lib/api";
import type { UsbDevice, UsbDeviceStatus } from "@/lib/types";
import { USBDeviceCard } from "./USBDeviceCard";

interface WSLUSBPanelProps {
  /** Active WSL distro name (target of attach). Empty = default distro. */
  distro: string;
  /** Whether the WSL terminal is currently connected. */
  connected: boolean;
  onClose?: () => void;
}

/** Transient per-device status (Connecting / Error) layered over backend data. */
interface Override {
  status: UsbDeviceStatus;
  error?: string;
}

const POLL_MS = 8000;

export function WSLUSBPanel({ distro, connected, onClose }: WSLUSBPanelProps) {
  const [resolvedDistro, setResolvedDistro] = useState(distro);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [detected, setDetected] = useState<UsbDevice | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "error" } | null>(
    null,
  );

  const prevBusIds = useRef<Set<string>>(new Set());
  // Guard against overlapping refreshes: if a (slow) `usbipd list` is still
  // running, the poll timer must not spawn another one on top of it.
  const inFlight = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, kind: "info" | "error" = "info") => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // Resolve the effective distro: if the caller didn't pin one, fall back to the
  // WSL default so attach/detach have a concrete target.
  useEffect(() => {
    if (distro) {
      setResolvedDistro(distro);
      return;
    }
    let cancelled = false;
    wsl
      .listDistros()
      .then((list) => {
        if (cancelled) return;
        const d = list.find((x) => x.isDefault) ?? list[0];
        if (d) setResolvedDistro(d.name);
      })
      .catch(() => {
        /* leave as-is; the status line will surface "未选择发行版" */
      });
    return () => {
      cancelled = true;
    };
  }, [distro]);

  /** Fetch the device list, preserving serial ports / Connected state across polls. */
  const loadList = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const fresh = await usb.list();
      setDevices((prev) =>
        fresh.map((d) => {
          const old = prev.find((p) => p.busid === d.busid);
          if (!old) return d;
          // Preserve a user-confirmed "Connected" state across polls. Some
          // usbipd-win versions don't report an attached device as "Connected"
          // in `usbipd list`, so without this the card would flip back to
          // "Connect" the instant the next poll ran. Only an explicit Disconnect
          // (which sets the status back to Available) or the device leaving the
          // list can clear it.
          if (old.status === "Connected" && d.status !== "Connected") {
            return {
              ...d,
              status: "Connected",
              serial_ports: d.serial_ports.length > 0 ? d.serial_ports : old.serial_ports,
            };
          }
          // Keep previously detected serial ports if the refresh dropped them.
          if (d.serial_ports.length === 0 && old.serial_ports.length > 0) {
            return { ...d, serial_ports: old.serial_ports };
          }
          return d;
        }),
      );
      setError(null);

      // Detect newly plugged-in devices and prompt the user.
      const freshIds = new Set(fresh.map((d) => d.busid));
      if (prevBusIds.current.size > 0) {
        const added = fresh.find(
          (d) => !prevBusIds.current.has(d.busid) && d.status !== "Connected",
        );
        if (added) setDetected(added);
      }
      prevBusIds.current = freshIds;
    } catch (e) {
      setError(`刷新设备失败：${e}`);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  /** Ensure usbipd is installed, then load the list. */
  const checkInstalled = useCallback(async () => {
    try {
      const ok = await usb.isInstalled();
      setInstalled(ok);
      if (ok) loadList();
    } catch {
      setInstalled(false);
    }
  }, [loadList]);

  useEffect(() => {
    checkInstalled();
  }, [checkInstalled]);

  // While usbipd-win is not yet detected, keep re-checking on an interval. This
  // self-heals when the user installs it (or when the running app was launched
  // before the install and only learns about the binary via the known install
  // path) without forcing a panel/app restart.
  useEffect(() => {
    if (installed === true) return;
    const id = setInterval(checkInstalled, 5000);
    return () => clearInterval(id);
  }, [installed, checkInstalled]);

  // ── Auto-refresh while the panel is mounted and usbipd is present. ──
  useEffect(() => {
    if (installed !== true) return;
    const id = setInterval(loadList, POLL_MS);
    return () => clearInterval(id);
  }, [installed, loadList]);

  // Re-check when the target distro changes.
  useEffect(() => {
    if (installed === true) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDistro]);

  const handleConnect = async (device: UsbDevice) => {
    if (!resolvedDistro) {
      showToast("请先选择目标 WSL 发行版", "error");
      return;
    }
    setOverrides((o) => ({ ...o, [device.busid]: { status: "Connecting" } }));
    try {
      const verify = await usb.attach(device.busid, resolvedDistro);
      setDevices((prev) =>
        prev.map((d) =>
          d.busid === device.busid
            ? { ...d, status: "Connected", serial_ports: verify.serial_ports }
            : d,
        ),
      );
      setOverrides((o) => {
        const next = { ...o };
        delete next[device.busid];
        return next;
      });
      if (verify.serial_ports.length > 0) {
        showToast(`已连接 ${device.friendly_name} → ${verify.serial_ports.join(", ")}`);
      } else {
        showToast(`已连接 ${device.friendly_name} 到 ${resolvedDistro}`);
      }
      if (verify.note) showToast(verify.note);
    } catch (e) {
      const msg = String(e);
      setOverrides((o) => ({
        ...o,
        [device.busid]: { status: "Error", error: msg },
      }));
      showToast(`连接失败：${msg}`, "error");
    }
  };

  const handleDisconnect = async (device: UsbDevice) => {
    setOverrides((o) => ({ ...o, [device.busid]: { status: "Connecting" } }));
    try {
      await usb.detach(device.busid);
      setDevices((prev) =>
        prev.map((d) =>
          d.busid === device.busid
            ? { ...d, status: "Available", serial_ports: [] }
            : d,
        ),
      );
      setOverrides((o) => {
        const next = { ...o };
        delete next[device.busid];
        return next;
      });
      showToast(`已断开 ${device.friendly_name}，设备已归还 Windows`);
    } catch (e) {
      const msg = String(e);
      setOverrides((o) => ({
        ...o,
        [device.busid]: { status: "Error", error: msg },
      }));
      showToast(`断开失败：${msg}`, "error");
    }
  };

  const handleInstall = async () => {
    try {
      await usb.install();
      showToast("正在打开 usbipd-win 安装程序（winget）…");
    } catch (e) {
      showToast(`无法启动安装：${e}`, "error");
    }
  };

  const effectiveStatus = (d: UsbDevice): UsbDeviceStatus =>
    overrides[d.busid]?.status ?? d.status;
  const effectiveError = (d: UsbDevice): string | undefined => overrides[d.busid]?.error;
  const isBusy = (d: UsbDevice): boolean => overrides[d.busid]?.status === "Connecting";

  return (
    <div className="relative flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="flex h-9 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip h-6 w-6 shrink-0">
          <UsbIcon size={13} />
        </span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">
          USB Devices
        </span>
        <SideIconButton
          label="Refresh device list"
          onClick={loadList}
          icon={<RefreshCw size={14} className={loading ? "animate-spin" : undefined} />}
        />
        {onClose && (
          <SideIconButton label="Close USB panel" onClick={onClose} icon={<X size={14} />} />
        )}
      </div>

      {/* Status line */}
      <div
        className={cn(
          "border-b border-border px-2.5 py-1.5 font-mono text-[11px]",
          installed === true
            ? "text-success"
            : installed === false
              ? "text-warning"
              : "text-subtle",
        )}
      >
        {installed === true
          ? `usbipd 已就绪 · ${resolvedDistro || "（默认发行版）"}`
          : installed === false
            ? `未安装 usbipd-win · ${resolvedDistro || "（未选择发行版）"}`
            : "正在检测 usbipd-win…"}
      </div>

      {!connected && (
        <div className="border-b border-border bg-accent/10 px-2.5 py-1.5 text-[11px] text-muted">
          连接 WSL 后即可将 USB 设备转发到该发行版。
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {installed === null && (
          <p className="p-4 text-center text-[12px] text-subtle">正在检查 usbipd-win…</p>
        )}

        {installed === false && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-5 text-center">
            <UsbIcon size={28} className="text-subtle" />
            <p className="text-[12px] leading-relaxed text-muted">
              未安装 <span className="font-semibold text-fg">usbipd-win</span>。
              <br />
              安装后即可在 WSL 中访问 USB 开发设备。
            </p>
            <Button variant="primary" size="sm" onClick={handleInstall}>
              安装 usbipd-win
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={checkInstalled}
              title="重新检测 usbipd-win 是否已安装"
            >
              重试检测
            </Button>
            <code className="w-full break-all rounded bg-bg px-2 py-1 font-mono text-[10px] text-accent">
              winget install --interactive --exact dorssel.usbipd-win
            </code>
          </div>
        )}

        {installed === true && devices.length === 0 && !loading && (
          <p className="p-4 text-center text-[12px] leading-relaxed text-subtle">
            未检测到嵌入式开发设备。
            <br />
            插入 ESP32 / ST-Link / 串口设备等后会出现在这里。
          </p>
        )}

        {error && (
          <p className="rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">{error}</p>
        )}

        {installed === true &&
          devices.map((d) => (
            <USBDeviceCard
              key={d.busid}
              device={d}
              status={effectiveStatus(d)}
              error={effectiveError(d)}
              busy={isBusy(d)}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onToast={showToast}
            />
          ))}
      </div>

      {/* Plug-in detection toast (inside panel) */}
      {detected && (
        <div className="border-t border-accent bg-bg px-2.5 py-2">
          <p className="mb-1.5 text-[12px] text-fg">
            检测到 <span className="font-semibold">{detected.friendly_name}</span>
            <br />
            连接到 {resolvedDistro || "默认发行版"}？
          </p>
          <div className="flex gap-1.5">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void handleConnect(detected);
                setDetected(null);
              }}
            >
              Connect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDetected(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Local toast (over the whole window) */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-[100] max-w-[70%] -translate-x-1/2 cursor-pointer rounded-lg border px-4 py-2 text-[12px] text-white shadow-xl",
            toast.kind === "error" ? "border-danger bg-danger" : "border-accent bg-elevated",
          )}
          onClick={() => setToast(null)}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
