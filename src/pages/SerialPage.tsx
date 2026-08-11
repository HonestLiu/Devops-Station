import { useEffect, useMemo, useState } from "react";
import { Cable, Usb, Bluetooth, Scan } from "lucide-react";

import { Button, Field, Select } from "@/components/ui";
import { PortPicker } from "@/components/serial/PortPicker";
import { serial, ble } from "@/lib/api";
import { useTabsStore } from "@/store/useTabsStore";
import {
  BLE_PRESETS,
  CUSTOM_GATT,
  normalizeGattProfile,
  validateGattProfile,
  shortUuid,
  type BleProfile,
} from "@/lib/bleGatt";
import type { BleDeviceInfo, SerialOpenConfig } from "@/lib/types";

const FALLBACK_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const DATA_BITS = [5, 6, 7, 8];
const PARITY: SerialOpenConfig["parity"][] = ["none", "odd", "even"];
const STOP_BITS = [1, 2];
const FLOW_CONTROL: SerialOpenConfig["flowControl"][] = ["none", "software", "hardware"];

const LS_PRESET = "devops-station:ble-preset";
const LS_CUSTOM = "devops-station:ble-custom";

interface CustomGatt {
  service: string;
  write: string;
  notify: string;
}

const inputCls =
  "h-9 w-full rounded border border-border bg-bg px-2 text-[13px] text-fg outline-none focus:border-accent";

export function SerialPage() {
  const openSerial = useTabsStore((s) => s.openSerial);

  const [activeTab, setActiveTab] = useState<"serial" | "bluetooth">("serial");

  const [port, setPort] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [baudRates, setBaudRates] = useState<number[]>(FALLBACK_BAUD_RATES);
  const [dataBits, setDataBits] = useState<SerialOpenConfig["dataBits"]>(8);
  const [parity, setParity] = useState<SerialOpenConfig["parity"]>("none");
  const [stopBits, setStopBits] = useState<SerialOpenConfig["stopBits"]>(1);
  const [flowControl, setFlowControl] = useState<SerialOpenConfig["flowControl"]>("none");
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    serial
      .baudRates()
      .then((rates) => {
        if (alive && rates.length > 0) setBaudRates(rates);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const baudOptions = useMemo(() => {
    return baudRates.includes(baudRate) ? baudRates : [...baudRates, baudRate].sort((a, b) => a - b);
  }, [baudRates, baudRate]);

  const open = async () => {
    if (!port.trim()) return;
    setOpening(true);
    try {
      await openSerial(
        {
          port: port.trim(),
          baudRate,
          dataBits,
          stopBits,
          parity,
          flowControl,
        },
        port.trim(),
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">串口终端</h1>
          <p className="page-subtitle">选择串口或蓝牙设备，打开一个临时调试会话</p>
        </div>
      </div>

      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        {/* Transport tabs */}
        <div className="card p-1">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab("serial")}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (activeTab === "serial" ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
              }
            >
              <Usb size={14} /> 串口
            </button>
            <button
              onClick={() => setActiveTab("bluetooth")}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (activeTab === "bluetooth" ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
              }
            >
              <Bluetooth size={14} /> 蓝牙
            </button>
          </div>
        </div>

        {activeTab === "serial" ? (
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold text-fg">
              <Cable size={15} className="text-accent" />
              串口设置
              <span className="text-[12px] font-normal text-subtle">请选择串口并连接相关参数</span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="串口" className="sm:col-span-2 lg:col-span-3">
                <PortPicker value={port} onChange={setPort} autoSelectFirst />
              </Field>

              <Field label="波特率">
                <Select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
                  {baudOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="数据位">
                <Select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value) as SerialOpenConfig["dataBits"])}>
                  {DATA_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="校验位">
                <Select value={parity} onChange={(e) => setParity(e.target.value as SerialOpenConfig["parity"])}>
                  {PARITY.map((p) => (
                    <option key={p} value={p}>
                      {p === "none" ? "None" : p === "odd" ? "Odd" : "Even"}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="停止位">
                <Select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value) as SerialOpenConfig["stopBits"])}>
                  {STOP_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="流控" className="sm:col-span-2 lg:col-span-1">
                <Select value={flowControl} onChange={(e) => setFlowControl(e.target.value as SerialOpenConfig["flowControl"])}>
                  {FLOW_CONTROL.map((f) => (
                    <option key={f} value={f}>
                      {f === "none" ? "None" : f === "software" ? "XON/XOFF" : "RTS/CTS"}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="mt-5 flex items-center justify-end">
              <Button
                variant="primary"
                onClick={open}
                disabled={!port.trim() || opening}
                className="min-w-[140px]"
              >
                <Cable size={14} /> {opening ? "打开中…" : "选择串口设备"}
              </Button>
            </div>
          </div>
        ) : (
          <BluetoothPanel />
        )}
      </div>
    </div>
  );
}

/**
 * BLE transparent-transmission connect panel.
 *
 * Mirrors the reference SerialAssistant flow: pick a GATT profile preset (or a
 * fully custom one), scan for nearby peripherals, then open a serial-style
 * session. The actual GATT connection lives in the Rust backend (btleplug);
 * this panel only collects the profile + target device and hands them to
 * `openBle`, which reuses the exact same record / plot / send stack as serial.
 */
function BluetoothPanel() {
  const openBle = useTabsStore((s) => s.openBle);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [presetName, setPresetName] = useState<string>(
    () => localStorage.getItem(LS_PRESET) ?? BLE_PRESETS[0].name,
  );
  const [custom, setCustom] = useState<CustomGatt>(() => {
    try {
      const raw = localStorage.getItem(LS_CUSTOM);
      if (raw) return JSON.parse(raw) as CustomGatt;
    } catch {
      /* ignore corrupt cache */
    }
    return { service: "", write: "", notify: "" };
  });

  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let alive = true;
    ble
      .available()
      .then((a) => alive && setAvailable(a))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_PRESET, presetName);
  }, [presetName]);

  useEffect(() => {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(custom));
  }, [custom]);

  const isCustom = presetName === CUSTOM_GATT;
  const preset = BLE_PRESETS.find((p) => p.name === presetName) ?? BLE_PRESETS[0];

  // Live validation of the custom fields so we can disable Connect early.
  const customValidation = useMemo(() => {
    if (!isCustom) return { valid: true as const };
    return validateGattProfile({
      name: CUSTOM_GATT,
      description: "",
      service: custom.service,
      writeCharacteristic: custom.write,
      notifyCharacteristic: custom.notify,
      custom: true,
    });
  }, [isCustom, custom]);

  const scan = async () => {
    setError(null);
    setScanning(true);
    try {
      const list = await ble.scan(4000);
      setDevices(list);
      if (list.length === 0) {
        setError("未发现蓝牙设备。请确认设备已上电并处于可发现状态后重试。");
      } else {
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      }
    } catch (e) {
      setError((e as Error).message || "扫描失败");
    } finally {
      setScanning(false);
    }
  };

  const selected = devices.find((d) => d.id === selectedId) ?? null;

  const connect = async () => {
    if (!selected) {
      setError("请先选择一个设备");
      return;
    }
    let profile: { service: string; writeCharacteristic: string; notifyCharacteristic?: string };
    try {
      const src: BleProfile = isCustom
        ? {
            name: CUSTOM_GATT,
            description: "",
            service: custom.service,
            writeCharacteristic: custom.write,
            notifyCharacteristic: custom.notify,
            custom: true,
          }
        : preset;
      profile = normalizeGattProfile(src);
    } catch (e) {
      setError((e as Error).message);
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      await openBle(
        {
          deviceId: selected.id,
          deviceName: selected.name || undefined,
          service: profile.service,
          writeCharacteristic: profile.writeCharacteristic,
          notifyCharacteristic: profile.notifyCharacteristic,
        },
        selected.name || selected.address,
      );
    } catch (e) {
      setError((e as Error).message || "连接失败");
      setConnecting(false);
    }
  };

  if (available === false) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Bluetooth size={36} className="text-subtle" />
        <p className="text-[14px] font-medium text-muted">本机未检测到蓝牙适配器</p>
        <p className="max-w-sm text-[12px] text-subtle">
          请确认蓝牙已开启，或当前设备配有可用的蓝牙硬件后再试。
        </p>
      </div>
    );
  }

  if (available === null) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Bluetooth size={36} className="animate-pulse text-subtle" />
        <p className="text-[13px] text-muted">正在检测蓝牙适配器…</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold text-fg">
        <Bluetooth size={15} className="text-accent" />
        蓝牙透传设置
        <span className="text-[12px] font-normal text-subtle">
          选择 GATT 配置并连接附近的蓝牙串口设备
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: GATT profile */}
        <div className="flex flex-col gap-3">
          <Field label="GATT 配置模板">
            <Select value={presetName} onChange={(e) => setPresetName(e.target.value)}>
              {BLE_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

          {!isCustom && (
            <p className="text-[12px] leading-relaxed text-subtle">{preset.description}</p>
          )}

          {isCustom && (
            <div className="flex flex-col gap-3">
              <Field label="服务 UUID（16/32/128 位）">
                <input
                  className={inputCls}
                  value={custom.service}
                  placeholder="例如 FFE0 或 6e400001-..."
                  onChange={(e) => setCustom((c) => ({ ...c, service: e.target.value }))}
                />
              </Field>
              <Field label="写入特征 UUID（主机 → 设备）">
                <input
                  className={inputCls}
                  value={custom.write}
                  placeholder="例如 FFE1 或 6e400002-..."
                  onChange={(e) => setCustom((c) => ({ ...c, write: e.target.value }))}
                />
              </Field>
              <Field label="通知特征 UUID（设备 → 主机，可留空）">
                <input
                  className={inputCls}
                  value={custom.notify}
                  placeholder="留空为仅发送模式"
                  onChange={(e) => setCustom((c) => ({ ...c, notify: e.target.value }))}
                />
              </Field>
              {!customValidation.valid && (
                <p className="text-[12px] text-danger">{customValidation.error}</p>
              )}
            </div>
          )}
        </div>

        {/* Right: device list */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-fg">已发现设备</span>
            <Button variant="secondary" size="sm" onClick={scan} disabled={scanning}>
              <Scan size={13} className={scanning ? "animate-spin" : ""} />
              {scanning ? "扫描中…" : "扫描"}
            </Button>
          </div>

          <div className="flex max-h-72 min-h-[120px] flex-col gap-1 overflow-y-auto rounded border border-border p-1">
            {!scanning && devices.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-subtle">
                尚未扫描，点击「扫描」查找附近的蓝牙设备。
              </p>
            )}
            {devices.map((d) => {
              const active = d.id === selectedId;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className={
                    "flex flex-col gap-0.5 rounded px-2 py-2 text-left transition-colors " +
                    (active ? "bg-accent/15 ring-1 ring-inset ring-accent" : "hover:bg-hover")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">
                      {d.name || "未知设备"}
                    </span>
                    {d.rssi != null && (
                      <span className="shrink-0 font-mono text-[11px] text-subtle">{d.rssi} dBm</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-subtle">
                    <span className="truncate">{d.address}</span>
                    {d.services.length > 0 && (
                      <span className="shrink-0 truncate">
                        · {d.services.slice(0, 3).map((s) => shortUuid(s)).join(" ")}
                        {d.services.length > 3 ? " …" : ""}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>
      )}

      <div className="mt-5 flex items-center justify-end">
        <Button
          variant="primary"
          onClick={connect}
          disabled={scanning || connecting || !selected || (isCustom && !customValidation.valid)}
          className="min-w-[140px]"
        >
          <Bluetooth size={14} /> {connecting ? "连接中…" : "连接设备"}
        </Button>
      </div>
    </div>
  );
}
