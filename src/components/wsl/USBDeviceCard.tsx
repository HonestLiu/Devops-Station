import { emit } from "@tauri-apps/api/event";
import { Bug, Cpu, Loader2, PlugZap, Usb } from "lucide-react";

import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { UsbAction, UsbCategory, UsbDevice, UsbDeviceStatus } from "@/lib/types";

const CATEGORY_ICON: Record<UsbCategory, typeof Usb> = {
  "USB Serial": Usb,
  "Debug Probe": Bug,
  "MCU Dev Board": Cpu,
  "USB-JTAG": PlugZap,
};

const STATUS_TONE: Record<
  UsbDeviceStatus,
  "success" | "warning" | "accent" | "danger" | "neutral"
> = {
  Connected: "success",
  Available: "warning",
  Bound: "warning",
  Connecting: "accent",
  Error: "danger",
};

/** Build embeddev-specific quick actions for a device. */
function buildActions(device: UsbDevice): UsbAction[] {
  const actions: UsbAction[] = [];
  const name = device.friendly_name.toLowerCase();

  switch (device.category) {
    case "USB-JTAG":
      actions.push({ label: "OpenOCD", event: "reserved-action" });
      actions.push({ label: "Debug", event: "reserved-action" });
      break;
    case "Debug Probe":
      if (name.includes("st-link")) {
        actions.push({ label: "OpenOCD", event: "reserved-action" });
      } else if (name.includes("j-link")) {
        actions.push({ label: "JLink Commander", event: "reserved-action" });
      }
      actions.push({ label: "Debug", event: "reserved-action" });
      break;
    case "MCU Dev Board":
      if (name.includes("esp32")) {
        actions.push({ label: "Flash Firmware", event: "reserved-action" });
      }
      break;
    default:
      break;
  }
  return actions;
}

interface USBDeviceCardProps {
  device: UsbDevice;
  /** Effective status = backend status merged with transient (Connecting/Error). */
  status: UsbDeviceStatus;
  /** Transient error message shown when status === "Error". */
  error?: string | null;
  /** True while a connect/disconnect operation is in flight. */
  busy: boolean;
  onConnect: (device: UsbDevice) => void;
  onDisconnect: (device: UsbDevice) => void;
  /** Surfaced for reserved actions (Open Serial / Debug / Flash). */
  onToast?: (msg: string, kind?: "info" | "error") => void;
}

export function USBDeviceCard({
  device,
  status,
  error,
  busy,
  onConnect,
  onDisconnect,
  onToast,
}: USBDeviceCardProps) {
  const isConnected = status === "Connected";
  const isAvailable = status === "Available" || status === "Bound";
  const actions = buildActions(device);

  const Icon = CATEGORY_ICON[device.category] ?? Usb;

  const openSerial = (port: string) => {
    // Forward-compat: the future Serial Terminal will listen for this event.
    void emit("open-serial", { port, baud: 115200 });
    onToast?.(`已请求打开串口 ${port} @ 115200（Serial Terminal 功能预留）`);
  };

  const runAction = (action: UsbAction) => {
    void emit(action.event, {
      label: action.label,
      busid: device.busid,
      friendly_name: device.friendly_name,
    });
    onToast?.(`「${action.label}」功能预留`);
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-border border-l-2 bg-elevated p-2.5",
        status === "Connected" && "border-l-success",
        (status === "Available" || status === "Bound") && "border-l-warning",
        status === "Connecting" && "border-l-accent",
        status === "Error" && "border-l-danger",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-[16px] leading-none text-accent">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-fg">
            {device.friendly_name}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            {device.vid}:{device.pid} · {device.category}
          </div>
        </div>
        <Badge tone={STATUS_TONE[status]}>
          {status === "Connecting" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Connecting
            </span>
          ) : (
            status
          )}
        </Badge>
      </div>

      {error && status === "Error" && (
        <p className="mt-2 rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">
          {error}
        </p>
      )}

      {isConnected && device.serial_ports.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {device.serial_ports.map((port) => (
            <Button
              key={port}
              variant="secondary"
              size="sm"
              onClick={() => openSerial(port)}
              title={`Open ${port} at 115200 baud`}
            >
              <Usb size={13} />
              Open Serial · {port}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {isAvailable && (
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => onConnect(device)}
          >
            Connect
          </Button>
        )}
        {isConnected && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => onDisconnect(device)}
          >
            Disconnect
          </Button>
        )}

        {device.serial_ports.length === 0 &&
          device.category === "USB Serial" &&
          isConnected && (
            <span className="text-[10px] italic text-subtle">
              no serial port detected
            </span>
          )}

        {actions.map((a) => (
          <Button
            key={a.label}
            variant="ghost"
            size="sm"
            disabled={!isConnected}
            title={isConnected ? a.label : "Connect the device first"}
            onClick={() => runAction(a)}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
