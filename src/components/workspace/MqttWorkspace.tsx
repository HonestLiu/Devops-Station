import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowDownToLine,
  Check,
  Copy,
  Inbox,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Send,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import { Button, SideIconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { mqtt } from "@/lib/api";
import { useTabsStore } from "@/store/useTabsStore";
import type { MqttMessage, MqttStatus, Tab, TabStatus } from "@/lib/types";

const MAX_MESSAGES = 500;

type DirectionFilter = "all" | "received" | "published";
type PayloadFormat = "text" | "json" | "hex" | "base64";

/** string → base64 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** bytes → base64 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Parse the editor payload into raw bytes according to the chosen format. */
function payloadToBytes(format: PayloadFormat, text: string): Uint8Array {
  if (format === "hex") {
    const hex = text.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length % 2) throw new Error("Invalid hex");
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
  if (format === "base64") {
    const clean = text.replace(/\s/g, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  if (format === "json") {
    JSON.parse(text); // validate
  }
  return new TextEncoder().encode(text);
}

/** Decode a base64 payload for display in the selected format. */
function formatPayload(b64: string, format: PayloadFormat): { text: string; kind: "text" | "binary" } {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    if (format === "base64") return { text: b64, kind: "text" };
    if (format === "hex") {
      return {
        text: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "),
        kind: "text",
      };
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const hasBinary = !text || /[�]/.test(text) || /[\x00-\x08\x0E-\x1F]/.test(text);
    if (hasBinary) return { text: b64, kind: "binary" };

    if (format === "json") {
      try {
        return { text: JSON.stringify(JSON.parse(text), null, 2), kind: "text" };
      } catch {
        return { text, kind: "text" };
      }
    }
    return { text, kind: "text" };
  } catch {
    return { text: b64, kind: "binary" };
  }
}

function StatusBadge({ status }: { status?: MqttStatus["status"] | TabStatus }) {
  const t = useT();
  const map: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
    connecting: {
      label: t("mqtt.connecting"),
      cls: "bg-amber-500/15 text-amber-500",
      icon: <Loader2 size={12} className="animate-spin" />,
    },
    connected: {
      label: t("mqtt.connected"),
      cls: "bg-emerald-500/15 text-emerald-500",
      icon: <Wifi size={12} />,
    },
    reconnecting: {
      label: t("mqtt.reconnecting"),
      cls: "bg-amber-500/15 text-amber-500",
      icon: <Loader2 size={12} className="animate-spin" />,
    },
    error: {
      label: t("mqtt.connectionFailed"),
      cls: "bg-danger/15 text-danger",
      icon: <WifiOff size={12} />,
    },
    disconnected: {
      label: t("mqtt.disconnected"),
      cls: "bg-muted/15 text-muted",
      icon: <Plug size={12} />,
    },
    closed: {
      label: t("mqtt.disconnected"),
      cls: "bg-muted/15 text-muted",
      icon: <Plug size={12} />,
    },
  };
  const s = (status && map[status]) || map.connecting;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

const fieldCls =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60";
const selectCls =
  "rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent/60";
const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle";

interface Sub {
  topic: string;
  qos: number;
}

export function MqttWorkspace({ tab }: { tab: Tab }) {
  const t = useT();
  const sessionId = tab.sessionId;
  const patch = useTabsStore((s) => s.patch);
  const hostId = tab.mqtt?.id;

  const [messages, setMessages] = useState<MqttMessage[]>([]);
  const [status, setStatus] = useState<MqttStatus | null>(null);
  // Seed subscriptions/publish form from the persisted connection profile so
  // they survive a tab close and sync across devices.
  const [subs, setSubs] = useState<Sub[]>(
    (tab.mqtt?.subscriptions ?? []).map((s) => ({ topic: s.topic, qos: s.qos })),
  );

  // subscription input
  const [showSubInput, setShowSubInput] = useState(false);
  const [subTopic, setSubTopic] = useState("");
  const [subQos, setSubQos] = useState(0);
  const [subErr, setSubErr] = useState<string | undefined>();
  // collapsible subscriptions rail
  const [subsCollapsed, setSubsCollapsed] = useState(false);

  // publisher
  const [pubTopic, setPubTopic] = useState(tab.mqtt?.publish?.topic ?? "");
  const [pubPayload, setPubPayload] = useState(tab.mqtt?.publish?.payload ?? "");
  const [pubQos, setPubQos] = useState(tab.mqtt?.publish?.qos ?? 0);
  const [pubRetain, setPubRetain] = useState(tab.mqtt?.publish?.retain ?? false);
  const [pubErr, setPubErr] = useState<string | undefined>();
  const [pubFormat, setPubFormat] = useState<PayloadFormat>("text");

  // message list
  const [filter, setFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [displayFormat, setDisplayFormat] = useState<PayloadFormat>("text");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let unMsg: UnlistenFn | undefined;
    let unSt: UnlistenFn | undefined;
    const offs: Promise<UnlistenFn>[] = [];
    offs.push(
      mqtt
        .onMessage(sessionId, (m) => {
          setMessages((prev) => {
            const next = [...prev, m];
            return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
          });
        })
        .then((u) => (unMsg = u)),
    );
    offs.push(mqtt.onStatus(sessionId, (s) => setStatus(s)).then((u) => (unSt = u)));
    return () => {
      unMsg?.();
      unSt?.();
    };
  }, [sessionId]);

  // Keep the latest subscriptions in a ref so a reconnect can re-subscribe them.
  const subsRef = useRef(subs);
  subsRef.current = subs;

  // Whenever the session becomes connected (initial connect or a reconnect),
  // restore the persisted subscriptions so they survive a tab close and sync
  // across devices.
  useEffect(() => {
    if (status?.status === "connected" && sessionId) {
      for (const sub of subsRef.current) {
        mqtt.subscribe(sessionId, sub.topic, sub.qos, hostId).catch(() => undefined);
      }
    }
  }, [status?.status, sessionId, hostId]);

  const subscribe = async () => {
    if (!sessionId || !subTopic.trim()) return;
    setSubErr(undefined);
    try {
      await mqtt.subscribe(sessionId, subTopic.trim(), subQos, hostId);
      setSubs((s) =>
        s.some((x) => x.topic === subTopic.trim()) ? s : [...s, { topic: subTopic.trim(), qos: subQos }],
      );
      setSubTopic("");
      setShowSubInput(false);
    } catch (e) {
      setSubErr((e as Error).message);
    }
  };

  const unsubscribe = async (topic: string) => {
    if (!sessionId) return;
    await mqtt.unsubscribe(sessionId, topic, hostId).catch(() => undefined);
    setSubs((s) => s.filter((x) => x.topic !== topic));
  };

  const publish = async () => {
    if (!sessionId || !pubTopic.trim()) return;
    setPubErr(undefined);
    try {
      const bytes = payloadToBytes(pubFormat, pubPayload);
      await mqtt.publish(sessionId, pubTopic.trim(), bytesToBase64(bytes), pubQos, pubRetain, hostId);
    } catch (e) {
      setPubErr((e as Error).message);
    }
  };

  const disconnect = async () => {
    if (!sessionId) return;
    await mqtt.disconnect(sessionId).catch(() => undefined);
    patch(tab.id, { status: "closed", sessionId: undefined });
    setStatus({ id: tab.id, status: "disconnected" });
  };

  const copy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
    });
  };

  const filtered = useMemo(() => {
    let list = messages;
    if (directionFilter !== "all") {
      const dir = directionFilter === "received" ? "in" : "out";
      list = list.filter((m) => m.direction === dir);
    }
    if (filter.trim()) {
      const f = filter.trim().toLowerCase();
      list = list.filter((m) => m.topic.toLowerCase().includes(f));
    }
    return list;
  }, [messages, directionFilter, filter]);

  const live = status?.status === "connected" || status?.status === "reconnecting";

  const FilterTab = ({ value }: { value: DirectionFilter }) => {
    const active = directionFilter === value;
    const labels: Record<DirectionFilter, string> = {
      all: t("mqtt.all"),
      received: t("mqtt.received"),
      published: t("mqtt.published"),
    };
    return (
      <button
        className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
          active ? "bg-accent text-white" : "text-subtle hover:bg-hover hover:text-fg"
        }`}
        onClick={() => setDirectionFilter(value)}
      >
        {labels[value]}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Top chrome — MQTTX-style connection header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-fg">{tab.title}</span>
          <StatusBadge status={status?.status ?? tab.status} />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={!sessionId}>
            <Plug size={13} className="text-danger" />
            <span className="ml-1">{t("mqtt.disconnect")}</span>
          </Button>
        </div>
      </div>

      {(status?.status === "error" || tab.status === "error") && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
          {status?.detail || tab.error || t("mqtt.connectionFailed")}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar — subscriptions (collapsible rail) */}
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r border-border/60 bg-surface/30 transition-[width] duration-200",
            subsCollapsed ? "w-9" : "w-56",
          )}
        >
          {subsCollapsed ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <SideIconButton
                label={t("mqtt.expandSubs")}
                onClick={() => setSubsCollapsed(false)}
                icon={<PanelLeftOpen size={14} />}
              />
              <span className="text-[10px] font-semibold text-subtle" title={`${subs.length} ${t("mqtt.subscriptions")}`}>
                {subs.length}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-border/60 p-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 justify-start gap-1.5"
                  onClick={() => setShowSubInput((s) => !s)}
                  disabled={!live}
                >
                  <Plus size={13} />
                  {t("mqtt.newSubscription")}
                </Button>
                <SideIconButton
                  label={t("mqtt.collapseSubs")}
                  onClick={() => setSubsCollapsed(true)}
                  icon={<PanelLeftClose size={14} />}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {showSubInput && (
                  <div className="mb-2 rounded-md border border-border/60 bg-bg p-2">
                    <input
                      className={`${fieldCls} mb-2`}
                      placeholder={t("mqtt.topic")}
                      value={subTopic}
                      onChange={(e) => setSubTopic(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void subscribe()}
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <select
                        className={selectCls}
                        value={subQos}
                        onChange={(e) => setSubQos(Number(e.target.value))}
                      >
                        <option value={0}>QoS 0</option>
                        <option value={1}>QoS 1</option>
                        <option value={2}>QoS 2</option>
                      </select>
                      <Button variant="primary" size="sm" className="ml-auto" onClick={subscribe}>
                        {t("mqtt.subscribe")}
                      </Button>
                    </div>
                    {subErr && <div className="mt-1.5 text-[11px] text-danger">{subErr}</div>}
                  </div>
                )}

                {subs.length === 0 ? (
                  <div className="py-6 text-center text-[12px] text-muted">{t("mqtt.noSubscriptions")}</div>
                ) : (
                  <div className="space-y-1">
                    {subs.map((s) => (
                      <div
                        key={s.topic}
                        className={`group flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-[12px] ${
                          filter === s.topic ? "bg-accent/15 text-accent" : "hover:bg-hover"
                        }`}
                        onClick={() => setFilter((f) => (f === s.topic ? "" : s.topic))}
                        title={t("mqtt.filter")}
                      >
                        <span className="truncate font-mono">{s.topic}</span>
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="text-[10px] text-muted">Q{s.qos}</span>
                          <button
                            className="rounded p-0.5 hover:text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              void unsubscribe(s.topic);
                            }}
                            title={t("mqtt.unsubscribe")}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border/60 p-2 text-[11px] text-muted">
                {subs.length} {t("mqtt.subscriptions")}
              </div>
            </>
          )}
        </aside>

        {/* Right area — messages (top) + publisher (bottom) */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Messages */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <Inbox size={14} className="text-subtle" />
              <span className="text-[12px] font-semibold text-fg">{t("mqtt.messages")}</span>
              <span className="text-[11px] text-muted">({filtered.length})</span>

              <select
                className={`${selectCls} ml-2`}
                value={displayFormat}
                onChange={(e) => setDisplayFormat(e.target.value as PayloadFormat)}
                title={t("mqtt.format")}
              >
                <option value="text">{t("mqtt.text")}</option>
                <option value="json">{t("mqtt.json")}</option>
                <option value="hex">{t("mqtt.hex")}</option>
                <option value="base64">{t("mqtt.base64")}</option>
              </select>

              <div className="ml-auto flex items-center gap-1">
                <FilterTab value="all" />
                <FilterTab value="received" />
                <FilterTab value="published" />
              </div>

              <input
                className="ml-2 w-40 rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent/60"
                placeholder={t("mqtt.filter")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMessages([])}
                disabled={messages.length === 0}
                title={t("mqtt.clear")}
              >
                <Trash2 size={13} />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
                  <ArrowDownToLine size={22} />
                  <span className="text-[12px]">{t("mqtt.noMessages")}</span>
                </div>
              ) : (
                <div className="space-y-1">
                  {filtered.map((m, i) => {
                    const { text, kind } = formatPayload(m.payloadBase64, displayFormat);
                    const key = `${m.timestamp}-${i}`;
                    return (
                      <div key={key} className="rounded-md border border-border/50 bg-bg/60 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 text-[11px]">
                          <span
                            className={`rounded px-1.5 py-0.5 font-medium ${
                              m.direction === "in"
                                ? "bg-sky-500/15 text-sky-500"
                                : "bg-violet-500/15 text-violet-500"
                            }`}
                          >
                            {m.direction === "in" ? t("mqtt.in") : t("mqtt.out")}
                          </span>
                          <span className="truncate font-mono text-subtle">{m.topic}</span>
                          <span className="ml-auto shrink-0 text-muted">
                            {new Date(m.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="mt-1 flex items-start gap-2">
                          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-fg">
                            {text}
                          </pre>
                          <button
                            className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-fg"
                            onClick={() => copy(kind === "text" ? text : m.payloadBase64, key)}
                            title={t("mqtt.copyPayload")}
                          >
                            {copiedId === key ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                          </button>
                        </div>
                        <div className="mt-1 flex gap-1 text-[10px] text-muted">
                          <span className="rounded bg-border/50 px-1">Q{m.qos}</span>
                          {m.retain && <span className="rounded bg-border/50 px-1">{t("mqtt.retain")}</span>}
                          {kind === "binary" && <span className="rounded bg-border/50 px-1">{t("mqtt.base64")}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Publisher */}
          <div className="flex h-64 shrink-0 flex-col border-t border-border/60 bg-surface/30">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
              <input
                className={`${fieldCls} max-w-[260px]`}
                placeholder={t("mqtt.topic")}
                value={pubTopic}
                onChange={(e) => setPubTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void publish()}
              />

              <select
                className={selectCls}
                value={pubFormat}
                onChange={(e) => setPubFormat(e.target.value as PayloadFormat)}
                title={t("mqtt.format")}
              >
                <option value="text">{t("mqtt.text")}</option>
                <option value="json">{t("mqtt.json")}</option>
                <option value="hex">{t("mqtt.hex")}</option>
                <option value="base64">{t("mqtt.base64")}</option>
              </select>

              <select
                className={selectCls}
                value={pubQos}
                onChange={(e) => setPubQos(Number(e.target.value))}
                title={t("mqtt.qos")}
              >
                <option value={0}>QoS 0</option>
                <option value={1}>QoS 1</option>
                <option value={2}>QoS 2</option>
              </select>

              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg">
                <input
                  type="checkbox"
                  checked={pubRetain}
                  onChange={(e) => setPubRetain(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                />
                {t("mqtt.retain")}
              </label>

              {pubErr && <span className="ml-2 truncate text-[11px] text-danger">{pubErr}</span>}

              <Button
                variant="primary"
                size="sm"
                className="ml-auto gap-1"
                onClick={publish}
                disabled={!live || !pubTopic.trim()}
              >
                <Send size={13} />
                {t("mqtt.send")}
              </Button>
            </div>

            <textarea
              className="min-h-0 flex-1 resize-none border-0 bg-bg px-3 py-2 font-mono text-[13px] text-fg outline-none placeholder:text-muted"
              placeholder={t("mqtt.payload")}
              value={pubPayload}
              onChange={(e) => setPubPayload(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void publish();
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
