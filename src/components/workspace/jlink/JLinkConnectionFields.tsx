import { Field, Select } from "@/components/ui";
import { useT } from "@/i18n";
import type { JLinkConfig } from "@/lib/types";
import { SPEEDS, inputCls } from "./shared";

/**
 * The shared probe settings row — target device (with driver datalist),
 * interface (SWD/JTAG) and speed (kHz, 0 = auto). Used by every J-Link module
 * workspace.
 */
export function JLinkConnectionFields({
  config,
  setConfig,
  devices,
}: {
  config: JLinkConfig;
  setConfig: (config: JLinkConfig) => void;
  devices: string[];
}) {
  const t = useT();
  return (
    <>
      <Field label={t("jlink.device")}>
        <input
          list="jlink-devices"
          className={inputCls}
          value={config.device}
          onChange={(e) => setConfig({ ...config, device: e.target.value })}
          placeholder={t("jlink.devicePh")}
        />
        <datalist id="jlink-devices">
          {devices.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <p className="mt-1.5 text-[11px] text-subtle">
          {t("jlink.deviceCount", { n: devices.length })}
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t("jlink.iface")}>
          <Select
            value={config.iface}
            onChange={(e) =>
              setConfig({ ...config, iface: e.target.value as JLinkConfig["iface"] })
            }
          >
            <option value="SWD">SWD</option>
            <option value="JTAG">JTAG</option>
          </Select>
        </Field>
        <Field label={t("jlink.speed")}>
          <Select
            value={String(config.speed)}
            onChange={(e) => setConfig({ ...config, speed: Number(e.target.value) })}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? t("jlink.auto") : `${s} kHz`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
  );
}
