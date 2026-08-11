/**
 * GATT serial-bridge profiles.
 *
 * Ported from the reference project's `bleGatt.js` + `useBleStore.js`. The
 * presets cover the transparent-transmission modules people actually buy; the
 * custom entry lets anything else through as long as the UUIDs parse.
 *
 * Note the connection itself is nothing like the reference: it used the browser
 * Web Bluetooth API, we drive a native BLE central in the Rust backend. Only the
 * profile shape and UUID normalisation carry over — and they have to match the
 * backend's `parse_gatt_uuid`, which is why the rules are duplicated here (the
 * UI must be able to reject a bad UUID before a scan is even attempted).
 */

const SHORT_UUID = /^(?:0x)?([0-9a-f]{4}|[0-9a-f]{8})$/i;
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BleProfile {
  /** Preset key; also the label shown in the picker. */
  name: string;
  description: string;
  /** Undefined on the custom preset until the user fills the fields in. */
  service: string;
  writeCharacteristic: string;
  /** Empty means "write-only link" — no RX subscription. */
  notifyCharacteristic: string;
  /** Custom presets scan without a service filter (≈ acceptAllDevices). */
  custom?: boolean;
}

export const CUSTOM_GATT = "自定义 GATT";

export const BLE_PRESETS: BleProfile[] = [
  {
    name: "通用Ⅰ型",
    description: "适用于 DX-BT24 等常见蓝牙串口透传模块",
    service: "FFE0",
    writeCharacteristic: "FFE1",
    notifyCharacteristic: "FFE1",
  },
  {
    name: "通用Ⅱ型",
    description: "适用于 DX-BT16 等蓝牙串口透传模块",
    service: "FFE0",
    writeCharacteristic: "FFE2",
    notifyCharacteristic: "FFE1",
  },
  {
    name: "Nordic UART (NUS)",
    description: "nRF5x / 多数国产 BLE SoC 的默认串口服务",
    service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    writeCharacteristic: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    notifyCharacteristic: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  },
  {
    name: CUSTOM_GATT,
    description: "使用自定义 GATT 服务和特征值 UUID",
    service: "",
    writeCharacteristic: "",
    notifyCharacteristic: "",
    custom: true,
  },
];

/**
 * Normalise a 16-/32-bit shorthand or a full 128-bit UUID to its canonical
 * lowercase 128-bit form. Throws with a field-specific message on bad input.
 */
export function normalizeGattUuid(value: string, field = "UUID"): string {
  const raw = String(value ?? "").trim();
  const short = raw.match(SHORT_UUID);
  if (short) {
    // Bluetooth Base UUID: 0000xxxx-0000-1000-8000-00805F9B34FB
    const n = Number.parseInt(short[1], 16) >>> 0;
    return `${n.toString(16).padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
  }
  if (FULL_UUID.test(raw)) return raw.toLowerCase();
  throw new TypeError(`${field} 必须是有效的 16 位、32 位或 128 位 UUID`);
}

export interface NormalizedProfile {
  service: string;
  writeCharacteristic: string;
  /** Undefined when the profile declares no RX characteristic. */
  notifyCharacteristic?: string;
}

export function normalizeGattProfile(profile: BleProfile): NormalizedProfile {
  const notify = profile.notifyCharacteristic?.trim();
  return {
    service: normalizeGattUuid(profile.service, "服务 UUID"),
    writeCharacteristic: normalizeGattUuid(profile.writeCharacteristic, "写入特征 UUID"),
    notifyCharacteristic: notify ? normalizeGattUuid(notify, "通知特征 UUID") : undefined,
  };
}

/** Non-throwing variant, for live validation while the user types. */
export function validateGattProfile(
  profile: BleProfile,
): { valid: true; profile: NormalizedProfile } | { valid: false; error: string } {
  try {
    return { valid: true, profile: normalizeGattProfile(profile) };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

/** Short label for a UUID — collapses the Bluetooth base form back to 0xFFE0. */
export function shortUuid(uuid: string): string {
  const m = uuid.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i);
  return m ? `0x${m[1].toUpperCase()}` : uuid;
}
