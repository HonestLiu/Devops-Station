import { useState } from "react";
import { Globe, MonitorSmartphone, Plus, Server, TerminalSquare, Trash2 } from "lucide-react";

import { DistroPicker } from "@/components/wsl/DistroPicker";
import { Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { isWindows } from "@/lib/platform";
import { useT, type TKey } from "@/i18n";
import { useHostsStore, emptyHost } from "@/store/useHostsStore";
import type { FrpConfig, FrpProxy, FrpProxyType, FrpServer, Host, HostKind } from "@/lib/types";

const COLORS = [
  "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e",
  "#bb9af7", "#7dcfff", "#ff9e64", "#41a6b5",
];

// Serial has its own dedicated page, so it's not a "host" you save here.
const KIND_TABS: { id: HostKind; labelKey: TKey; icon: typeof Server }[] = [
  { id: "ssh", labelKey: "hosts.kindSsh", icon: Server },
  { id: "wsl", labelKey: "hosts.kindWsl", icon: TerminalSquare },
  { id: "frp", labelKey: "hosts.kindFrp", icon: Globe },
  { id: "local", labelKey: "hosts.kindLocal", icon: MonitorSmartphone },
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
  const t = useT();
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

  const validate = (): string | undefined => {
    if (!host.name.trim()) return t("hostDialog.nameRequired");
    if (host.kind === "ssh" && !host.hostname?.trim()) return t("hostDialog.hostnameRequired");
    if (host.kind === "frp") {
      if (!frpConfig.server?.serverAddr?.trim()) return t("hostDialog.serverRequired");
      if (!frpConfig.proxies.length) return t("hostDialog.proxyRequired");
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
      title={host.id ? t("hostDialog.edit", { name: host.name }) : t("hostDialog.new")}
      description={t("hostDialog.description")}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
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
                {t(k.labelKey)}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("hostDialog.name")} className="col-span-2">
            <Input
              value={host.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={t("hostDialog.phServer")}
              className="select-text"
            />
          </Field>

          {host.kind === "ssh" && (
            <>
              <Field label={t("hostDialog.hostname")}>
                <Input
                  value={host.hostname ?? ""}
                  onChange={(e) => patch({ hostname: e.target.value })}
                  placeholder={t("hostDialog.phHost")}
                  className="select-text"
                />
              </Field>
              <Field label={t("hostDialog.port")}>
                <Input
                  type="number"
                  value={host.port ?? 22}
                  onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
                />
              </Field>
              <Field label={t("hostDialog.username")}>
                <Input
                  value={host.username ?? ""}
                  onChange={(e) => patch({ username: e.target.value })}
                  placeholder={t("hostDialog.phUser")}
                  className="select-text"
                />
              </Field>
              <Field
                label={t("hostDialog.password")}
                hint={host.password === SAVED ? t("hostDialog.pwStored") : undefined}
              >
                <Input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder={host.password === SAVED ? t("hostDialog.phPwUnchanged") : ""}
                  className="select-text"
                />
              </Field>
              <Field label={t("hostDialog.privateKey")} className="col-span-2">
                <Input
                  value={host.privateKeyPath ?? ""}
                  onChange={(e) => patch({ privateKeyPath: e.target.value })}
                  placeholder={t("hostDialog.phKey")}
                  className="select-text font-mono text-[12px]"
                />
              </Field>
              <Field label={t("hostDialog.passphrase")} className="col-span-2">
                <Input
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  placeholder={host.passphrase === SAVED ? t("hostDialog.phPwUnchanged") : t("hostDialog.phOptional")}
                  className="select-text"
                />
              </Field>
            </>
          )}

          {host.kind === "wsl" && (
            <>
              <Field label={t("hostDialog.distribution")} className="col-span-2" hint={t("hostDialog.distroHint")}>
                <DistroPicker
                  value={host.wslDistro ?? ""}
                  onChange={(distro) => patch({ wslDistro: distro })}
                />
              </Field>
              <Field label={t("hostDialog.user")} className="col-span-2" hint={t("hostDialog.userHint")}>
                <Input
                  value={host.wslUser ?? ""}
                  onChange={(e) => patch({ wslUser: e.target.value })}
                  placeholder={t("hostDialog.phDefaultUser")}
                  className="select-text"
                />
              </Field>
              <Field label={t("hostDialog.startDir")} className="col-span-2" hint={t("hostDialog.cwdHint")}>
                <Input
                  value={host.wslCwd ?? ""}
                  onChange={(e) => patch({ wslCwd: e.target.value })}
                  placeholder={t("hostDialog.phHome")}
                  className="select-text font-mono text-[12px]"
                />
              </Field>
            </>
          )}

          {host.kind === "frp" && (
            <FrpForm config={frpConfig} onChange={setFrpConfig} />
          )}

          <Field label={t("hostDialog.color")} className="col-span-2">
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

          <Field label={t("hostDialog.tags")} hint={t("hostDialog.tagsHint")} className="col-span-2">
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder={t("hostDialog.phTags")}
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
  const t = useT();
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
          {t("hostDialog.frpServer")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("hostDialog.frpServerAddr")}>
            <Input
              value={server.serverAddr}
              onChange={(e) => setServer({ serverAddr: e.target.value })}
              placeholder={t("hostDialog.frpPhServer")}
              className="select-text"
            />
          </Field>
          <Field label={t("hostDialog.frpServerPort")}>
            <Input
              type="number"
              value={server.serverPort}
              onChange={(e) => setServer({ serverPort: Number(e.target.value) || 7000 })}
            />
          </Field>
          <Field label={t("hostDialog.frpToken")} hint={t("hostDialog.frpOptional")}>
            <Input
              type="password"
              value={server.token ?? ""}
              onChange={(e) => setServer({ token: e.target.value || null })}
              placeholder={t("hostDialog.frpOptional")}
              className="select-text"
            />
          </Field>
          <Field label={t("hostDialog.frpUser")} hint={t("hostDialog.frpOptional")}>
            <Input
              value={server.user ?? ""}
              onChange={(e) => setServer({ user: e.target.value || null })}
              placeholder={t("hostDialog.frpOptional")}
              className="select-text"
            />
          </Field>
          <Field label={t("hostDialog.frpTls")}>
            <span className="flex h-8 items-center gap-2 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={!!server.tlsEnable}
                onChange={(e) => setServer({ tlsEnable: e.target.checked })}
              />
              {t("hostDialog.frpEnableTls")}
            </span>
          </Field>
          <Field label={t("hostDialog.frpLogLevel")} hint={t("hostDialog.frpOptional")}>
            <Select
              value={server.logLevel ?? ""}
              onChange={(e) => setServer({ logLevel: e.target.value || null })}
            >
              <option value="">{t("hostDialog.frpLogDefault")}</option>
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
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            {t("hostDialog.frpProxies")}
          </div>
          <Button variant="secondary" size="sm" onClick={addProxy}>
            <Plus size={13} /> {t("hostDialog.frpAddProxy")}
          </Button>
        </div>
        {config.proxies.map((p, i) => (
          <div key={i} className="rounded-md border border-border bg-bg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={p.name}
                onChange={(e) => setProxy(i, { name: e.target.value })}
                placeholder={t("hostDialog.frpPhProxy")}
                className="flex-1 select-text font-mono text-[12px]"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeProxy(i)}
                title={t("hostDialog.frpRemoveProxy")}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label={t("hostDialog.frpType")}>
                <Select
                  value={p.type}
                  onChange={(e) => setProxy(i, { type: e.target.value as FrpProxyType })}
                >
                  {FRP_PROXY_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {ty}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("hostDialog.frpLocalIp")}>
                <Input
                  value={p.localIp}
                  onChange={(e) => setProxy(i, { localIp: e.target.value })}
                  placeholder={t("hostDialog.frpPhLocalIp")}
                  className="select-text font-mono text-[11px]"
                />
              </Field>
              <Field label={t("hostDialog.frpLocalPort")}>
                <Input
                  type="number"
                  value={p.localPort}
                  onChange={(e) => setProxy(i, { localPort: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label={t("hostDialog.frpRemotePort")} hint="tcp/udp">
                <Input
                  type="number"
                  value={p.remotePort ?? ""}
                  onChange={(e) =>
                    setProxy(i, { remotePort: e.target.value ? Number(e.target.value) : null })
                  }
                  placeholder="—"
                />
              </Field>
              <Field label={t("hostDialog.frpDomains")} hint="http/https, comma-sep" className="col-span-2">
                <Input
                  value={p.customDomains ?? ""}
                  onChange={(e) => setProxy(i, { customDomains: e.target.value || null })}
                  placeholder={t("hostDialog.frpPhDomains")}
                  className="select-text"
                />
              </Field>
              <Field label={t("hostDialog.frpSubdomain")} hint={t("hostDialog.frpOptional")}>
                <Input
                  value={p.subdomain ?? ""}
                  onChange={(e) => setProxy(i, { subdomain: e.target.value || null })}
                  placeholder={t("hostDialog.frpOptional")}
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
                {t("hostDialog.frpEncrypt")}
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input
                  type="checkbox"
                  checked={!!p.useCompression}
                  onChange={(e) => setProxy(i, { useCompression: e.target.checked })}
                />
                {t("hostDialog.frpCompress")}
              </label>
            </div>
          </div>
        ))}
        {config.proxies.length === 0 && (
          <p className="text-[12px] text-subtle">{t("hostDialog.frpNoProxies")}</p>
        )}
      </div>
    </div>
  );
}
