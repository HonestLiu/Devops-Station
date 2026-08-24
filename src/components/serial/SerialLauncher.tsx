import { useEffect, useMemo, useState } from "react";
import { Cable, Usb, Bluetooth, Scan, X } from "lucide-react";

import { Button, Field, Select } from "@/components/ui";
import { PortPicker } from "@/components/serial/PortPicker";
import { serial, ble } from "@/lib/api";
import { useT } from "@/i18n";
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

/**
 * The "基础串口工具" module — the serial / BLE connection launcher. Extracted
 * from the old `SerialPage` so it can live as a singleton module tab
 * (`serialModule: "basic"`) opened from the module picker, mirroring how J-Link
 * modules open as tabs. Opening a device here spawns its own serial/ BLE
 * connection tab; this launcher stays mounted as a control surface.
 */
export function SerialLauncher() {
  const t = useT();
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

  // Open serial/BLE sessions — the launcher doubles as a multi-device manager so
  // you can jump back to a connected port or close it without leaving the page.
  // Only *device* connections count here: the basic-launcher and protocol-designer
  // module tabs are also `kind: "serial"` but carry a `serialModule`, so they
  // must be excluded or they'd show up as fake "open devices".
  const tabs = useTabsStore((s) => s.tabs);
  const openDevices = useMemo(
    () =>
      tabs.filter(
        (tab) => tab.kind === "ble" || (tab.kind === "serial" && !tab.serialModule),
      ),
    [tabs],
  );
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);

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
          <h1 className="page-title">{t("serialPage.title")}</h1>
          <p className="page-subtitle">{t("serialPage.subtitle")}</p>
        </div>
      </div>

      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        {/* Open-device chips: jump to or close a connected serial/BLE session. */}
        {openDevices.length > 0 && (
          <div className="card flex flex-wrap items-center gap-2 p-3">
            <span className="text-[12px] font-medium text-subtle">{t("serialPage.openDevices")}</span>
            {openDevices.map((dev) => (
              <span
                key={dev.id}
                className="flex items-center gap-1 rounded-full bg-accent/15 py-0.5 pl-2.5 pr-1 text-[12px] text-fg ring-1 ring-inset ring-accent/25"
              >
                <button
                  onClick={() => setActive(dev.id)}
                  className="flex items-center gap-1.5"
                  title={dev.title}
                >
                  <Cable size={12} className="shrink-0 text-accent" />
                  <span className="max-w-[160px] truncate">{dev.title}</span>
                </button>
                <button
                  onClick={() => void closeTab(dev.id)}
                  className="rounded-full p-0.5 text-subtle transition-colors hover:bg-border hover:text-fg"
                  aria-label={t("tabs.close")}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

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
              <Usb size={14} /> {t("serialPage.serialTab")}
            </button>
            <button
              onClick={() => setActiveTab("bluetooth")}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (activeTab === "bluetooth" ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
              }
            >
              <Bluetooth size={14} /> {t("serialPage.bleTab")}
            </button>
          </div>
        </div>

        {activeTab === "serial" ? (
          <div className="card p-5">
            <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold text-fg">
              <Cable size={15} className="text-accent" />
              {t("serialPage.serialSettings")}
              <span className="text-[12px] font-normal text-subtle">{t("serialPage.serialHint")}</span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label={t("serialPage.port")} className="sm:col-span-2 lg:col-span-3">
                <PortPicker value={port} onChange={setPort} autoSelectFirst />
              </Field>

              <Field label={t("ws.baud")}>
                <Select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
                  {baudOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("ws.dataBits")}>
                <Select value={dataBits} onChange={(e) => setDataBits(Number(e.target.value) as SerialOpenConfig["dataBits"])}>
                  {DATA_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("ws.parity")}>
                <Select value={parity} onChange={(e) => setParity(e.target.value as SerialOpenConfig["parity"])}>
                  {PARITY.map((p) => (
                    <option key={p} value={p}>
                      {p === "none" ? t("serialPage.parityNone") : p === "odd" ? t("serialPage.parityOdd") : t("serialPage.parityEven")}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("ws.stopBits")}>
                <Select value={stopBits} onChange={(e) => setStopBits(Number(e.target.value) as SerialOpenConfig["stopBits"])}>
                  {STOP_BITS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("ws.flow")} className="sm:col-span-2 lg:col-span-1">
                <Select value={flowControl} onChange={(e) => setFlowControl(e.target.value as SerialOpenConfig["flowControl"])}>
                  {FLOW_CONTROL.map((f) => (
                    <option key={f} value={f}>
                      {f === "none" ? t("serialPage.flowNone") : f === "software" ? t("serialPage.flowSoft") : t("serialPage.flowHard")}
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
                <Cable size={14} /> {opening ? t("serialPage.opening") : t("serialPage.selectPort")}
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
  const t = useT();
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
        setError(t("ble.noDeviceFound"));
      } else {
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      }
    } catch (e) {
      setError((e as Error).message || t("ble.scanFailed"));
    } finally {
      setScanning(false);
    }
  };

  const selected = devices.find((d) => d.id === selectedId) ?? null;

  const connect = async () => {
    if (!selected) {
      setError(t("ble.selectDevice"));
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
      setError((e as Error).message || t("ble.connectFailed"));
      setConnecting(false);
    }
  };

  if (available === false) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Bluetooth size={36} className="text-subtle" />
        <p className="text-[14px] font-medium text-muted"> {t("ble.noAdapter")}</p>
        <p className="max-w-sm text-[12px] text-subtle">
          {t("ble.noAdapterHint")}
        </p>
      </div>
    );
  }

  if (available === null) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Bluetooth size={36} className="animate-pulse text-subtle" />
        <p className="text-[13px] text-muted"> {t("ble.detecting")}</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold text-fg">
        <Bluetooth size={15} className="text-accent" />
        {t("ble.settingsTitle")}
        <span className="text-[12px] font-normal text-subtle">
          {t("ble.settingsHint")}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: GATT profile */}
        <div className="flex flex-col gap-3">
          <Field label={t("ble.gattTemplate")}>
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
              <Field label={t("ble.serviceUuid")}>
                <input
                  className={inputCls}
                  value={custom.service}
                  placeholder={t("ble.phService")}
                  onChange={(e) => setCustom((c) => ({ ...c, service: e.target.value }))}
                />
              </Field>
              <Field label={t("ble.writeChar")}>
                <input
                  className={inputCls}
                  value={custom.write}
                  placeholder={t("ble.phWrite")}
                  onChange={(e) => setCustom((c) => ({ ...c, write: e.target.value }))}
                />
              </Field>
              <Field label={t("ble.notifyChar")}>
                <input
                  className={inputCls}
                  value={custom.notify}
                  placeholder={t("ble.phNotify")}
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
            <span className="text-[12px] font-medium text-fg"> {t("ble.devicesFound")}</span>
            <Button variant="secondary" size="sm" onClick={scan} disabled={scanning}>
              <Scan size={13} className={scanning ? "animate-spin" : ""} />
              {scanning ? t("ble.scanning") : t("ble.scan")}
            </Button>
          </div>

          <div className="flex max-h-72 min-h-[120px] flex-col gap-1 overflow-y-auto rounded border border-border p-1">
            {!scanning && devices.length === 0 && (
              <p className="px-2 py-6 text-center text-[12px] text-subtle">
                {t("ble.notScanned")}
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
                      {d.name || t("ble.unknownDevice")}
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
          <Bluetooth size={14} /> {connecting ? t("common.connecting") : t("ble.connectDevice")}
        </Button>
      </div>
    </div>
  );
}
