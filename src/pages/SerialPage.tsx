import { useEffect, useMemo, useState } from "react";
import { Cable, Usb, Bluetooth } from "lucide-react";

import { Button, Field, Select } from "@/components/ui";
import { PortPicker } from "@/components/serial/PortPicker";
import { serial } from "@/lib/api";
import { useTabsStore } from "@/store/useTabsStore";
import type { SerialOpenConfig } from "@/lib/types";

const FALLBACK_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const DATA_BITS = [5, 6, 7, 8];
const PARITY: SerialOpenConfig["parity"][] = ["none", "odd", "even"];
const STOP_BITS = [1, 2];
const FLOW_CONTROL: SerialOpenConfig["flowControl"][] = ["none", "software", "hardware"];

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
          <p className="page-subtitle">选择串口并配置参数，打开一个临时调试会话</p>
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
          <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Bluetooth size={36} className="text-subtle" />
            <p className="text-[14px] font-medium text-muted">蓝牙串口功能即将到来</p>
            <p className="max-w-sm text-[12px] text-subtle">当前版本仅支持物理串口，蓝牙串口支持正在开发中。</p>
          </div>
        )}
      </div>
    </div>
  );
}
