import { useCallback, useEffect, useState } from "react";
import { Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";

import { Badge, Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { useT } from "@/i18n";
import { ssh } from "@/lib/api";
import type { ForwardType, PortForwardRule, PortForwardStatus } from "@/lib/types";

function newRule(hostId: string): PortForwardRule {
  return {
    id: crypto.randomUUID(),
    hostId,
    name: "",
    type: "local",
    localHost: "127.0.0.1",
    localPort: 0,
    remoteHost: "localhost",
    remotePort: 0,
    autoStart: false,
    sortOrder: 0,
    updatedAt: null,
  };
}

function describeRule(rule: PortForwardRule): string {
  switch (rule.type) {
    case "dynamic":
      return `${rule.localHost}:${rule.localPort || "?"} · SOCKS5`;
    case "remote":
      return `${rule.remoteHost}:${rule.remotePort || "?"} (server) → ${rule.localHost}:${rule.localPort || "?"} (local)`;
    case "local":
    default:
      return `${rule.localHost}:${rule.localPort || "?"} → ${rule.remoteHost}:${rule.remotePort || "?"}`;
  }
}

export function PortForwardPanel({
  sessionId,
  hostId,
  onClose,
}: {
  sessionId: string;
  hostId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const statusBadge = (status: PortForwardStatus["status"]) => {
    const map: Record<
      string,
      { tone: "success" | "accent" | "danger" | "neutral"; key: "pf.status.active" | "pf.status.connecting" | "pf.status.error" | "pf.status.inactive" }
    > = {
      active: { tone: "success", key: "pf.status.active" },
      connecting: { tone: "accent", key: "pf.status.connecting" },
      error: { tone: "danger", key: "pf.status.error" },
      inactive: { tone: "neutral", key: "pf.status.inactive" },
    };
    const s = map[status] ?? map.inactive;
    return <Badge tone={s.tone}>{t(s.key)}</Badge>;
  };
  const [rules, setRules] = useState<PortForwardRule[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PortForwardStatus>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PortForwardRule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [rs, st] = await Promise.all([
        hostId ? ssh.forwardRules(hostId) : Promise.resolve([] as PortForwardRule[]),
        ssh.forwardList(sessionId),
      ]);
      setRules(rs);
      const map: Record<string, PortForwardStatus> = {};
      for (const s of st) map[s.id] = s;
      setStatuses(map);
    } catch {
      /* non-fatal: panel still shows whatever we have */
    } finally {
      setLoading(false);
    }
  }, [hostId, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async (rule: PortForwardRule) => {
    setBusyId(rule.id);
    try {
      await ssh.forwardStart(sessionId, rule);
    } catch (e) {
      window.alert(t("pf.startError", { msg: (e as Error).message }));
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const stop = async (id: string) => {
    setBusyId(id);
    try {
      await ssh.forwardStop(id);
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const remove = async (id: string) => {
    await ssh.forwardDelete(id);
    await refresh();
  };

  const save = async (rule: PortForwardRule) => {
    try {
      const saved = await ssh.forwardSave(rule);
      setEditing(null);
      // Bring a freshly-saved auto-start rule (or any rule the user expects up)
      // online immediately if we already have a live session.
      try {
        await ssh.forwardStart(sessionId, saved);
      } catch {
        /* not fatal — user can press Start */
      }
    } catch (e) {
      window.alert(t("pf.saveError", { msg: (e as Error).message }));
    }
    await refresh();
  };

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2.5">
        <span className="text-[12px] font-semibold text-fg">{t("pf.title")}</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(newRule(hostId ?? ""))}
            title={t("pf.add")}
          >
            <Plus size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} title={t("hk.cancel")}>
            <X size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && rules.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-subtle">{t("ws.statusConnecting")}</p>
        )}
        {!loading && rules.length === 0 && (
          <p className="px-1 py-2 text-[12px] text-subtle">{t("pf.noRules")}</p>
        )}

        <ul className="flex flex-col gap-1.5">
          {rules.map((rule) => {
            const st = statuses[rule.id];
            const running = st?.status === "active";
            return (
              <li
                key={rule.id}
                className="rounded-lg border border-border bg-bg px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[12px] font-medium text-fg">
                    {rule.name || describeRule(rule)}
                  </span>
                  {statusBadge(st?.status ?? "inactive")}
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-subtle">
                  {describeRule(rule)}
                </p>
                {st?.error && (
                  <p className="mt-1 truncate text-[11px] text-danger" title={st.error}>
                    {st.error}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1">
                  {running ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === rule.id}
                      onClick={() => void stop(rule.id)}
                      title={t("pf.stop")}
                    >
                      <Square size={13} />
                      {t("pf.stop")}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyId === rule.id}
                      onClick={() => void start(rule)}
                      title={t("pf.start")}
                    >
                      <Play size={13} />
                      {t("pf.start")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(rule)}
                    title={t("pf.edit")}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(rule.id)}
                    title={t("kh.remove")}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={(r) => void save(r)}
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  onClose,
  onSave,
}: {
  rule: PortForwardRule;
  onClose: () => void;
  onSave: (rule: PortForwardRule) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<PortForwardRule>(rule);

  const set = <K extends keyof PortForwardRule>(key: K, value: PortForwardRule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const isDynamic = draft.type === "dynamic";

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule.id && rule.name ? t("pf.edit") : t("pf.add")}
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("hk.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => onSave(draft)}>
            {t("pf.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("pf.name")}>
          <Input
            value={draft.name}
            placeholder="my-tunnel"
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>

        <Field label={t("pf.type")}>
          <Select
            value={draft.type}
            onChange={(e) => set("type", e.target.value as ForwardType)}
          >
            <option value="local">{t("pf.type.local")}</option>
            <option value="remote">{t("pf.type.remote")}</option>
            <option value="dynamic">{t("pf.type.dynamic")}</option>
          </Select>
        </Field>

        {isDynamic ? (
          <p className="rounded-md bg-hover px-2 py-1.5 text-[11px] text-subtle">
            {t("pf.dynamicHint")}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("pf.localBind")}>
                <Input
                  value={draft.localHost}
                  onChange={(e) => set("localHost", e.target.value)}
                />
              </Field>
              <Field label={t("pf.localPort")}>
                <Input
                  type="number"
                  value={draft.localPort || ""}
                  onChange={(e) => set("localPort", Number(e.target.value) || 0)}
                />
              </Field>
            </div>

            {draft.type === "remote" ? (
              <p className="rounded-md bg-hover px-2 py-1.5 text-[11px] text-subtle">
                {t("pf.remoteHint")}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("pf.remoteHost")}>
                  <Input
                    value={draft.remoteHost}
                    onChange={(e) => set("remoteHost", e.target.value)}
                  />
                </Field>
                <Field label={t("pf.remotePort")}>
                  <Input
                    type="number"
                    value={draft.remotePort || ""}
                    onChange={(e) => set("remotePort", Number(e.target.value) || 0)}
                  />
                </Field>
              </div>
            )}
          </>
        )}

        <Checkbox
          checked={draft.autoStart ?? false}
          onChange={(v) => set("autoStart", v)}
          label={t("pf.autoStart")}
        />
      </div>
    </Dialog>
  );
}
