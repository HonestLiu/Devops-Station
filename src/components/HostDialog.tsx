import { useEffect, useMemo, useState } from "react";
import { Cable, Globe, MonitorSmartphone, Plus, Server, TerminalSquare, Trash2 } from "lucide-react";

import { PortPicker } from "@/components/serial/PortPicker";
import { DistroPicker } from "@/components/wsl/DistroPicker";
import { Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { serial } from "@/lib/api";
import { isWindows } from "@/lib/platform";
import { useHostsStore, emptyHost } from "@/store/useHostsStore";
import type { FrpConfig, FrpProxy, FrpProxyType, FrpServer, Host, HostKind } from "@/lib/types";

const COLORS = [
  "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e",
  "#bb9af7", "#7dcfff", "#ff9e64", "#41a6b5",
];

/** Used until the backend's canonical list arrives (and if that call ever fails). */
const FALLBACK_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const KIND_TABS: { id: HostKind; label: string; icon: typeof Server }[] = [
  { id: "ssh", label: "SSH", icon: Server },
  { id: "serial", label: "Serial", icon: Cable },
  { id: "wsl", label: "WSL", icon: TerminalSquare },
  { id: "frp", label: "Frp", icon: Globe },
  { id: "local", label: "Local", icon: MonitorSmartphone },
];

/** Sentinel the backend interprets as "keep the previously stored secret". */
const SAVED = "__saved__";

export function HostDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Host;
  onClose: () => void;
  onSaved: () => void;
}) {
  const saveHost = useHostsStore((s) => s.saveHost);
  const [host, setHost] = useState<Host>({ ...emptyHost(initial.kind), ...initial });
  const [passwordInput, setPasswordInput] = useState(
    initial.password === SAVED ? "" : initial.password ?? "",
  );
  const [passphraseInput, setPassphraseInput] = useState(
    initial.passphrase === SAVED ? "" : initial.passphrase ?? "",
  );
  const [tagsText, setTagsText] = useState((initial.tags ?? []).join(", "));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [baudRates, setBaudRates] = useState<number[]>(FALLBACK_BAUD_RATES);

  // Frp config lives in host.frpConfig as JSON; keep it structured while editing
  // so the form can mutate proxies without string-churn on every keystroke.
  const [frpConfig, setFrpConfig] = useState<FrpConfig>(() => {
    try {
      if (initial.frpConfig) return JSON.parse(initial.frpConfig) as FrpConfig;
    } catch {
      /* fall through to defaults */
    }
    return {
      server: { serverAddr: "", serverPort: 7000 },
      proxies: [
        { name: "ssh", type: "tcp", localIp: "127.0.0.1", localPort: 22, remotePort: 6022 },
      ],
    };
  });

  const patch = (p: Partial<Host>) => setHost((h) => ({ ...h, ...p }));

  // Pull the canonical baud list from the backend so UI and driver stay in sync.
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

  // Never drop a saved custom rate just because it isn't one of the presets.
  const baudOptions = useMemo(() => {
    const current = host.baudRate ?? 115200;
    return baudRates.includes(current)
      ? baudRates
      : [...baudRates, current].sort((a, b) => a - b);
  }, [baudRates, host.baudRate]);

  const validate = (): string | undefined => {
    if (!host.name.trim()) return "Name is required.";
    if (host.kind === "ssh" && !host.hostname?.trim()) return "Hostname is required.";
    if (host.kind === "serial" && !host.serialPort?.trim()) return "Serial port is required.";
    if (host.kind === "frp") {
      if (!frpConfig.server?.serverAddr?.trim()) return "Server address is required.";
      if (!frpConfig.proxies.length) return "Add at least one proxy.";
    }
    return undefined;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const built: Host = {
        ...host,
        name: host.name.trim(),
        tags: tagsText
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        // Preserve an existing stored secret when the field is left untouched.
        password:
          passwordInput || host.password === SAVED ? (passwordInput || SAVED) : passwordInput,
        passphrase:
          passphraseInput || host.passphrase === SAVED
            ? passphraseInput || SAVED
            : passphraseInput,
        frpConfig: host.kind === "frp" ? JSON.stringify(frpConfig) : host.frpConfig,
      };
      await saveHost(built);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={host.id ? `Edit ${host.name}` : "New Host"}
      description="Connections and secrets are stored locally, encrypted at rest."
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Kind selector. WSL is a Windows-only feature, so skip it on macOS/Linux. */}
        <div className="flex gap-1 rounded-md border border-border bg-bg p-1">
          {KIND_TABS.filter((k) => isWindows || k.id !== "wsl").map((k) => {
            const Icon = k.icon;
            const active = host.kind === k.id;
            return (
              <button
                key={k.id}
                onClick={() => patch({ kind: k.id })}
                className={
                  "flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 text-[12px] transition-colors " +
                  (active ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
                }
              >
                <Icon size={14} />
                {k.label}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" className="col-span-2">
            <Input
              value={host.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="My Server"
              className="select-text"
            />
          </Field>

          {host.kind === "ssh" && (
            <>
              <Field label="Hostname">
                <Input
                  value={host.hostname ?? ""}
                  onChange={(e) => patch({ hostname: e.target.value })}
                  placeholder="10.0.0.1 / box.local"
                  className="select-text"
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={host.port ?? 22}
                  onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
                />
              </Field>
              <Field label="Username">
                <Input
                  value={host.username ?? ""}
                  onChange={(e) => patch({ username: e.target.value })}
                  placeholder="root"
                  className="select-text"
                />
              </Field>
              <Field label="Password" hint={host.password === SAVED ? "Stored · leave blank to keep" : undefined}>
                <Input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder={host.password === SAVED ? "•••••••• (unchanged)" : ""}
                  className="select-text"
                />
              </Field>
              <Field label="Private key path" className="col-span-2">
                <Input
                  value={host.privateKeyPath ?? ""}
                  onChange={(e) => patch({ privateKeyPath: e.target.value })}
                  placeholder="~/.ssh/id_rsa"
                  className="select-text font-mono text-[12px]"
                />
              </Field>
              <Field label="Passphrase" className="col-span-2">
                <Input
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  placeholder={host.passphrase === SAVED ? "•••••••• (unchanged)" : "optional"}
                  className="select-text"
                />
              </Field>
            </>
          )}

          {host.kind === "serial" && (
            <>
              <Field label="Port" className="col-span-2">
                <PortPicker
                  value={host.serialPort ?? ""}
                  onChange={(port) => patch({ serialPort: port })}
                  // Only prefill on brand-new hosts; never overwrite a saved port.
                  autoSelectFirst={!host.id}
                />
              </Field>
              <Field label="Baud rate">
                <Select
                  value={host.baudRate ?? 115200}
                  onChange={(e) => patch({ baudRate: Number(e.target.value) })}
                >
                  {baudOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Data bits">
                <Select
                  value={host.dataBits ?? 8}
                  onChange={(e) => patch({ dataBits: Number(e.target.value) })}
                >
                  {[5, 6, 7, 8].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Stop bits">
                <Select
                  value={host.stopBits ?? 1}
                  onChange={(e) => patch({ stopBits: Number(e.target.value) })}
                >
                  {[1, 2].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Parity">
                <Select
                  value={host.parity ?? "none"}
                  onChange={(e) => patch({ parity: e.target.value })}
                >
                  {["none", "odd", "even"].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Flow control">
                <Select
                  value={host.flowControl ?? "none"}
                  onChange={(e) => patch({ flowControl: e.target.value })}
                >
                  {["none", "software", "hardware"].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}

          {host.kind === "wsl" && (
            <>
              <Field label="Distribution" className="col-span-2" hint="Leave empty to use WSL's default distro">
                <DistroPicker
                  value={host.wslDistro ?? ""}
                  onChange={(distro) => patch({ wslDistro: distro })}
                />
              </Field>
              <Field label="User" className="col-span-2" hint="Linux user inside the distro (wsl --user)">
                <Input
                  value={host.wslUser ?? ""}
                  onChange={(e) => patch({ wslUser: e.target.value })}
                  placeholder="default user"
                  className="select-text"
                />
              </Field>
              <Field label="Start directory" className="col-span-2" hint="Optional, passed as wsl --cd">
                <Input
                  value={host.wslCwd ?? ""}
                  onChange={(e) => patch({ wslCwd: e.target.value })}
                  placeholder="/home/user"
                  className="select-text font-mono text-[12px]"
                />
              </Field>
            </>
          )}

          {host.kind === "frp" && (
            <FrpForm config={frpConfig} onChange={setFrpConfig} />
          )}

          <Field label="Color" className="col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => patch({ color: c })}
                  className={
                    "h-6 w-6 rounded-full border-2 transition-transform " +
                    (host.color === c ? "scale-110 border-fg" : "border-transparent")
                  }
                  style={{ backgroundColor: c }}
                  aria-label={`color ${c}`}
                />
              ))}
            </div>
          </Field>

          <Field label="Tags" hint="comma separated" className="col-span-2">
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="prod, edge, raspberry"
              className="select-text"
            />
          </Field>
        </div>

        {error && <p className="text-[12px] text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

const FRP_PROXY_TYPES: FrpProxyType[] = ["tcp", "udp", "http", "https", "tcpmux", "stcp", "xtcp"];

/**
 * Editor for an Frp tunnel: the server ("common") block plus an add/remove list
 * of proxies. Kept as a controlled child so the parent only ever sees a single
 * `FrpConfig` value (re-serialized to `host.frpConfig` on save).
 */
function FrpForm({
  config,
  onChange,
}: {
  config: FrpConfig;
  onChange: (c: FrpConfig) => void;
}) {
  const server = config.server ?? { serverAddr: "", serverPort: 7000 };
  const setServer = (p: Partial<FrpServer>) =>
    onChange({ ...config, server: { ...server, ...p } });
  const setProxy = (i: number, p: Partial<FrpProxy>) =>
    onChange({
      ...config,
      proxies: config.proxies.map((x, j) => (j === i ? { ...x, ...p } : x)),
    });
  const addProxy = () =>
    onChange({
      ...config,
      proxies: [
        ...config.proxies,
        {
          name: `proxy${config.proxies.length + 1}`,
          type: "tcp",
          localIp: "127.0.0.1",
          localPort: 80,
          remotePort: null,
        },
      ],
    });
  const removeProxy = (i: number) =>
    onChange({ ...config, proxies: config.proxies.filter((_, j) => j !== i) });

  return (
    <div className="col-span-2 space-y-3">
      <div className="rounded-md border border-border bg-bg p-3 space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Server (common)
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Server address">
            <Input
              value={server.serverAddr}
              onChange={(e) => setServer({ serverAddr: e.target.value })}
              placeholder="frp.example.com"
              className="select-text"
            />
          </Field>
          <Field label="Server port">
            <Input
              type="number"
              value={server.serverPort}
              onChange={(e) => setServer({ serverPort: Number(e.target.value) || 7000 })}
            />
          </Field>
          <Field label="Token" hint="optional">
            <Input
              type="password"
              value={server.token ?? ""}
              onChange={(e) => setServer({ token: e.target.value || null })}
              placeholder="optional"
              className="select-text"
            />
          </Field>
          <Field label="User" hint="optional — frpc namespace">
            <Input
              value={server.user ?? ""}
              onChange={(e) => setServer({ user: e.target.value || null })}
              placeholder="optional"
              className="select-text"
            />
          </Field>
          <Field label="TLS">
            <span className="flex h-8 items-center gap-2 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={!!server.tlsEnable}
                onChange={(e) => setServer({ tlsEnable: e.target.checked })}
              />
              Enable TLS
            </span>
          </Field>
          <Field label="Log level" hint="optional">
            <Select
              value={server.logLevel ?? ""}
              onChange={(e) => setServer({ logLevel: e.target.value || null })}
            >
              <option value="">default</option>
              <option value="trace">trace</option>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </Select>
          </Field>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Proxies</div>
          <Button variant="secondary" size="sm" onClick={addProxy}>
            <Plus size={13} /> Add proxy
          </Button>
        </div>
        {config.proxies.map((p, i) => (
          <div key={i} className="rounded-md border border-border bg-bg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={p.name}
                onChange={(e) => setProxy(i, { name: e.target.value })}
                placeholder="proxy name"
                className="flex-1 select-text font-mono text-[12px]"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeProxy(i)}
                title="Remove proxy"
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Type">
                <Select
                  value={p.type}
                  onChange={(e) => setProxy(i, { type: e.target.value as FrpProxyType })}
                >
                  {FRP_PROXY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Local IP">
                <Input
                  value={p.localIp}
                  onChange={(e) => setProxy(i, { localIp: e.target.value })}
                  placeholder="127.0.0.1"
                  className="select-text font-mono text-[11px]"
                />
              </Field>
              <Field label="Local port">
                <Input
                  type="number"
                  value={p.localPort}
                  onChange={(e) => setProxy(i, { localPort: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Remote port" hint="tcp/udp">
                <Input
                  type="number"
                  value={p.remotePort ?? ""}
                  onChange={(e) =>
                    setProxy(i, { remotePort: e.target.value ? Number(e.target.value) : null })
                  }
                  placeholder="—"
                />
              </Field>
              <Field label="Custom domains" hint="http/https, comma-sep" className="col-span-2">
                <Input
                  value={p.customDomains ?? ""}
                  onChange={(e) => setProxy(i, { customDomains: e.target.value || null })}
                  placeholder="a.example.com, b.example.com"
                  className="select-text"
                />
              </Field>
              <Field label="Subdomain" hint="optional">
                <Input
                  value={p.subdomain ?? ""}
                  onChange={(e) => setProxy(i, { subdomain: e.target.value || null })}
                  placeholder="optional"
                  className="select-text"
                />
              </Field>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input
                  type="checkbox"
                  checked={!!p.useEncryption}
                  onChange={(e) => setProxy(i, { useEncryption: e.target.checked })}
                />
                Encrypt
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input
                  type="checkbox"
                  checked={!!p.useCompression}
                  onChange={(e) => setProxy(i, { useCompression: e.target.checked })}
                />
                Compress
              </label>
            </div>
          </div>
        ))}
        {config.proxies.length === 0 && (
          <p className="text-[12px] text-subtle">No proxies yet — add one above.</p>
        )}
      </div>
    </div>
  );
}
