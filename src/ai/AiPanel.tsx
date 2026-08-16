import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Activity,
  BookOpen,
  Bot,
  Cable,
  Check,
  Copy,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { Button, SideIconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAiStore, hasAiConfig } from "./useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { Markdown } from "./Markdown";
import { writeToTerminal } from "./terminalAi";
import { runAgent } from "./agent";
import { runAgentMulti, listHostSessions } from "./agentMulti";
import { useAiOrchestrator, type HostStatus } from "./useAiOrchestrator";
import { loadKnowledgeBase, kbChunkCount } from "./knowledgeBase";
import { analyzeTerminal, parseSerialProtocol, monitoringInsight } from "./tasks";
import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";
import type { AIChatMessage, AIChatSession } from "@/lib/types";

function SessionList() {
  const t = useT();
  // Subscribe to the stable array, filter transient sessions at render time
  // (a filter inside the selector would create a new array every render and
  // loop forever under zustand v5's Object.is comparison).
  const sessionsAll = useAiStore((s) => s.sessions);
  const sessions = sessionsAll.filter((x) => !x.transient);
  const activeId = useAiStore((s) => s.activeId);
  const newSession = useAiStore((s) => s.newSession);
  const selectSession = useAiStore((s) => s.selectSession);
  const closeSession = useAiStore((s) => s.closeSession);

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">
          {t("ai.history")}
        </span>
        <SideIconButton label={t("ai.newChat")} onClick={() => newSession()} icon={<Plus size={14} />} />
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <span className="icon-chip h-9 w-9">
              <MessageSquare size={15} />
            </span>
            <p className="text-[11px] leading-relaxed text-subtle">
              {t("ai.noConversations")}
              <br />
              {t("ai.tapPlus")} <Plus size={9} className="inline" />
            </p>
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => selectSession(s.id)}
            className={cn(
              "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors",
              s.id === activeId
                ? "bg-accent/15 text-fg ring-1 ring-inset ring-accent/20"
                : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <MessageSquare
              size={12}
              className={cn("shrink-0", s.id === activeId ? "text-accent" : "text-subtle")}
            />
            <span className="flex-1 truncate">{s.title || "New chat"}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
              className="shrink-0 rounded p-0.5 text-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              title="Close"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageView({
  session,
  onInsert,
  onRun,
}: {
  session: AIChatSession;
  onInsert?: (code: string) => void;
  onRun?: (code: string) => void;
}) {
  const t = useT();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selCopy, setSelCopy] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages]);

  // Frame-selection copy: when text inside the message area is drag-selected,
  // float a small "copy" button above the selection (in addition to the
  // per-bubble copy button), so the user can copy just part of a message.
  useEffect(() => {
    const onMouseUp = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      const inScope =
        sel && sel.rangeCount > 0
          ? scrollRef.current?.contains(sel.getRangeAt(0).commonAncestorContainer as Node)
          : false;
      if (!sel || !text || !inScope) {
        setSelCopy(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setSelCopy({
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 150)),
        y: rect.top,
        text,
      });
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) setSelCopy(null);
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, []);

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      {/* `select-text` overrides the app-wide user-select:none so chat history
          can be drag-selected and copied. */}
      <div
        ref={scrollRef}
        onScroll={() => setSelCopy(null)}
        className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-3 select-text"
      >
        {session.messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-4 px-6 py-8 text-center">
            <span className="icon-chip h-12 w-12">
              <Sparkles size={20} />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-fg">{t("ai.emptyTitle")}</p>
              <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-subtle">
                {t("ai.emptySubtitle")}
              </p>
            </div>
            <div className="flex flex-col gap-1.5 self-stretch">
              <button
                onClick={() => analyzeTerminal()}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
              >
                <ScrollText size={14} className="text-accent" />
                <span className="flex-1">{t("ai.analyzeTerminal")}</span>
                <span className="text-[10px] text-subtle">log</span>
              </button>
              <button
                onClick={() => parseSerialProtocol()}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
              >
                <Cable size={14} className="text-accent" />
                <span className="flex-1">{t("ai.parseSerial")}</span>
                <span className="text-[10px] text-subtle">serial</span>
              </button>
              <button
                onClick={() => void monitoringInsight()}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
              >
                <Activity size={14} className="text-accent" />
                <span className="flex-1">{t("ai.monitoringInsight")}</span>
                <span className="text-[10px] text-subtle">metrics</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-auto space-y-3">
            {session.messages.map((m) => (
              <MessageBubble key={m.id} m={m} onInsert={onInsert} onRun={onRun} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Frame-selection copy — floats above a drag-selection inside the chat */}
      {selCopy && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            void navigator.clipboard.writeText(selCopy.text).catch(() => undefined);
            setSelCopy(null);
          }}
          className="fixed z-50 flex h-7 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 text-[11px] font-medium text-fg shadow-xl transition-colors hover:bg-hover"
          style={{ left: selCopy.x, top: selCopy.y - 34 }}
        >
          <Copy size={12} />
          {t("common.copy")}
        </button>
      )}
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />;
}

/** One chat bubble with a per-message copy button (hover to reveal, copies the
 *  message's raw text — Markdown for assistant turns, plain for user turns). */
function MessageBubble({
  m,
  onInsert,
  onRun,
}: {
  m: AIChatMessage;
  onInsert?: (code: string) => void;
  onRun?: (code: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = m.content ?? "";
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div
      className={cn(
        "group relative flex items-end gap-2",
        m.role === "user" ? "justify-end" : "justify-start",
      )}
    >
      {m.role === "assistant" && (
        <span className="icon-chip h-6 w-6 shrink-0">
          <Sparkles size={12} />
        </span>
      )}
      <div
        className={cn(
          "relative max-w-[85%] px-3 py-2 pr-8 text-[13px] leading-relaxed",
          m.role === "user"
            ? "rounded-2xl rounded-br-sm bg-accent/15 text-fg"
            : m.error
              ? "rounded-2xl rounded-bl-sm border border-danger/40 bg-danger/10 text-danger"
              : "rounded-2xl rounded-bl-sm border border-border/60 bg-elevated text-fg",
        )}
      >
        {m.role === "assistant" ? (
          m.content ? (
            <Markdown content={m.content} onInsert={onInsert} onRun={onRun} />
          ) : (
            <span className="inline-flex gap-1 text-subtle">
              <Dot /> <Dot /> <Dot />
            </span>
          )
        ) : (
          <span className="whitespace-pre-wrap">{m.content}</span>
        )}
        {m.streaming && m.content && (
          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
        )}
        {m.content && (
          <button
            type="button"
            onClick={copy}
            title={t("common.copy")}
            aria-label={t("common.copy")}
            className={cn(
              "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md transition-colors",
              "text-subtle opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg",
              copied && "text-success opacity-100",
            )}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}

function Composer({
  sessionId,
  agentMode,
  agentAuto,
  multiHost = false,
  selectedHostIds = [],
}: {
  sessionId: string;
  agentMode: boolean;
  agentAuto: boolean;
  multiHost?: boolean;
  selectedHostIds?: string[];
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [needSetup, setNeedSetup] = useState(false);
  const [needHosts, setNeedHosts] = useState(false);
  const send = useAiStore((s) => s.send);
  const streaming = useAiStore(
    (s) =>
      s.sessions
        .find((x) => x.id === sessionId)
        ?.messages.some((m) => m.streaming) ?? false,
  );

  const submit = () => {
    if (!text.trim() || streaming) return;
    const value = text;
    setText("");
    if (!hasAiConfig()) {
      setNeedSetup(true);
      return;
    }
    if (multiHost) {
      if (selectedHostIds.length < 1) {
        setNeedHosts(true);
        return;
      }
      setNeedHosts(false);
      setNeedSetup(false);
      void runAgentMulti(value, selectedHostIds, agentAuto);
      return;
    }
    setNeedSetup(false);
    if (agentMode) {
      void runAgent(value, agentAuto);
    } else {
      void send(value);
    }
  };

  return (
    <div className="shrink-0 border-t border-border/70 bg-surface p-3">
      {needSetup && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <span className="flex-1 truncate text-[11px] text-fg">{t("ai.needSetup")}</span>
          <button
            onClick={() => {
              setNeedSetup(false);
              useAppStore.getState().setPage("settings");
            }}
            className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90"
          >
            {t("ai.goSettings")}
          </button>
          <button
            onClick={() => setNeedSetup(false)}
            className="shrink-0 rounded p-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.dismiss")}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {needHosts && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <span className="flex-1 truncate text-[11px] text-fg">{t("ai.multiNeedHosts")}</span>
          <button
            onClick={() => setNeedHosts(false)}
            className="shrink-0 rounded p-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.dismiss")}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border/80 bg-bg p-2 transition-shadow focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/30">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={t("ai.messagePlaceholder")}
          className="flex-1 resize-none bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
        />
        {streaming ? (
          <button
            onClick={() => useAiStore.getState().cancelActive()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger text-white transition hover:brightness-110"
            title={t("ai.stop")}
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
            title={t("ai.send")}
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Small colored chip reflecting a host's orchestration status. */
function StatusChip({ status }: { status: HostStatus }) {
  const t = useT();
  const map = {
    pending: { label: t("ai.multiStatusPending"), cls: "bg-border/50 text-muted" },
    running: { label: t("ai.multiStatusRunning"), cls: "bg-accent/15 text-accent" },
    done: { label: t("ai.multiStatusDone"), cls: "bg-success/15 text-success" },
    error: { label: t("ai.multiStatusError"), cls: "bg-danger/15 text-danger" },
  } as const;
  const m = map[status];
  return <span className={cn("pill shrink-0", m.cls)}>{m.label}</span>;
}

/**
 * Multi-host orchestration surface: pick target hosts, watch them run in
 * parallel, and read the cross-host synthesis. Reads live progress from
 * `useAiOrchestrator`.
 */
function MultiHostView({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const hosts = useAiOrchestrator((s) => s.hosts);
  const running = useAiOrchestrator((s) => s.running);
  const synthesis = useAiOrchestrator((s) => s.synthesis);
  const all = listHostSessions();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 select-text">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">
            {t("ai.multiSelectHosts")}
          </span>
          {selected.size > 0 && (
            <span className="pill bg-accent/15 text-accent">
              {t("ai.multiSelected", { n: selected.size })}
            </span>
          )}
        </div>
        {all.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-subtle">{t("ai.multiNoHosts")}</p>
        ) : (
          <div className="space-y-1">
            {all.map((h) => {
              const checked = selected.has(h.sessionId);
              return (
                <label
                  key={h.sessionId}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(h.sessionId)}
                    className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                  />
                  <span className="flex-1 truncate">{h.label}</span>
                  <span className="pill bg-border/50 text-muted">{h.kind}</span>
                </label>
              );
            })}
          </div>
        )}
        <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
          {t("ai.multiHostHint")}
        </p>
      </div>

      {hosts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">
              {t("ai.multiHostsCount", { n: hosts.length })}
            </span>
            {running && (
              <span className="pill bg-accent/15 text-accent">
                {t("ai.multiRunning", { n: hosts.length })}
              </span>
            )}
          </div>
          {hosts.map((h) => (
            <div key={h.sessionId} className="rounded-lg border border-border/70 bg-elevated p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium text-fg">{h.label}</span>
                <StatusChip status={h.status} />
              </div>
              {h.steps.length > 0 && (
                <div className="mb-1.5 space-y-0.5">
                  {h.steps.map((s, i) => (
                    <div key={i} className="truncate text-[11px] leading-snug">
                      <span className="font-mono text-accent">$ {s.cmd.split("\n")[0]}</span>
                      {s.result && (
                        <span className="ml-1 text-subtle">
                          {s.result.split("\n")[0].slice(0, 90)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {h.summary && (
                <div className="text-[11px] text-muted">
                  <span className="font-semibold">{t("ai.multiSummary")}: </span>
                  {h.summary}
                </div>
              )}
              {h.error && <div className="text-[11px] text-danger">{h.error}</div>}
            </div>
          ))}

          {synthesis && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-accent">
                {t("ai.multiSynthesis")}
              </div>
              <Markdown content={synthesis} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Docked right sidebar AI assistant. Hidden when closed; history is collapsible. */
export function AiPanel() {
  const t = useT();
  const panelOpen = useAiStore((s) => s.panelOpen);
  const width = useAiStore((s) => s.width);
  const setWidth = useAiStore((s) => s.setWidth);
  const togglePanel = useAiStore((s) => s.togglePanel);
  const activeId = useAiStore((s) => s.activeId);
  const sessions = useAiStore((s) => s.sessions);

  const terminalContext = useAppStore((s) => s.settings.ai.terminalContext);
  const [agentMode, setAgentMode] = useState(false);
  const [agentAuto, setAgentAuto] = useState(false);
  const [multiHost, setMultiHost] = useState(false);
  const [selectedHosts, setSelectedHosts] = useState<Set<string>>(new Set());
  const toggleHost = (id: string) =>
    setSelectedHosts((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // Structured KB load state (never infer status from translated text).
  type KbState =
    | { kind: "loading" }
    | { kind: "ready"; count: number }
    | { kind: "error"; err: string };
  const [kbState, setKbState] = useState<KbState | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadKb = async () => {
    const s = useAppStore.getState().settings.ai;
    if (!s.useKnowledgeBase || !s.knowledgeBasePath?.trim()) {
      setKbState({ kind: "error", err: t("ai.enableKb") });
      return;
    }
    setKbState({ kind: "loading" });
    try {
      await loadKnowledgeBase();
      setKbState({ kind: "ready", count: kbChunkCount() });
    } catch (e) {
      setKbState({ kind: "error", err: String(e) });
    }
  };

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeId);
  const cwdMap = useSessionStore((s) => s.cwdBySession);
  const activeTab = tabs.find(
    (t) => t.id === activeTabId && t.sessionId && t.kind !== "sftp",
  );

  // Reactive "terminal context attached" indicator: recompute only when the
  // inputs change (tabs / active tab / live cwd), instead of the old 800ms
  // polling interval which was wasteful and depended on the wrong activeId.
  const contextOn = useMemo(
    () => terminalContext && !!buildContext(),
    [terminalContext, tabs, activeTabId, cwdMap],
  );

  const onInsert = useCallback(
    (cmd: string) => {
      if (activeTab) writeToTerminal(cmd, false);
    },
    [activeTab],
  );
  const onRun = useCallback(
    (cmd: string) => {
      if (!activeTab) return;
      const c = cmd.trim();
      if (!c) return;
      if (window.confirm(t("ai.runConfirm", { title: activeTab.title, cmd: c }))) {
        writeToTerminal(c, true);
      }
    },
    [activeTab],
  );

  // Close on Escape.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") togglePanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, togglePanel]);

  // Plain computation (NOT a hook — must stay stable across the early return
  // below). Transient sessions (agent runs / auto-diagnose) never become the
  // visible chat session.
  const active =
    (activeId
      ? sessions.find((x) => x.id === activeId && !x.transient) ?? null
      : null) ??
    sessions.find((x) => !x.transient) ??
    null;

  if (!panelOpen) return null;

  // Drag-to-resize: a handle on the left edge updates the panel width.
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      setWidth(window.innerWidth - ev.clientX);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toolBtn = (active: boolean) =>
    cn(
      "flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors",
      active
        ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/25"
        : "text-muted hover:bg-hover hover:text-fg",
    );

  return (
    <div
      data-context="ai"
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-surface"
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-accent/50"
        title={t("ai.dragResize")}
      />
      {/* Header — session-level chrome: title left, session actions right
          (same shape as the Files / USB side panels: chip + title + icons) */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip h-6 w-6 shrink-0">
          <MessageSquare size={12} />
        </span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">{t("ai.assistant")}</span>
        {contextOn && (
          <span
            className="pill shrink-0 bg-accent/15 text-accent"
            title={t("ai.contextOnTitle")}
          >
            {t("ai.contextOn")}
          </span>
        )}
        <SideIconButton
          label={showHistory ? t("ai.collapseHistory") : t("ai.showHistory")}
          onClick={() => setShowHistory((v) => !v)}
          active={showHistory}
          icon={showHistory ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        />
        <SideIconButton
          label={t("ai.newChat")}
          onClick={() => useAiStore.getState().newSession()}
          icon={<Plus size={14} />}
        />
        <SideIconButton
          label={t("ai.closeEsc")}
          onClick={() => togglePanel(false)}
          icon={<X size={14} />}
        />
      </div>

      {/* Toolbar — agent / multi-host / KB mode toggles + status */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2.5">
        <button
          onClick={() => setAgentMode((v) => !v)}
          className={toolBtn(agentMode)}
          title={t("ai.agentTitle")}
        >
          <Bot size={13} /> {t("ai.agent")}
        </button>
        <button
          onClick={() => setMultiHost((v) => !v)}
          className={toolBtn(multiHost)}
          title={t("ai.multiHostTitle")}
        >
          <Cable size={13} /> {t("ai.multiHost")}
        </button>
        <button
          onClick={() => void loadKb()}
          className={toolBtn(kbState?.kind === "ready")}
          title={t("ai.kbTitle")}
        >
          <BookOpen size={13} /> {t("ai.kb")}
        </button>
        {kbState && (
          <span
            className="max-w-[110px] truncate text-[10px] text-subtle"
            title={
              kbState.kind === "ready"
                ? t("ai.kbChunks", { n: kbState.count })
                : kbState.kind === "loading"
                  ? t("ai.kbLoading")
                  : kbState.err
            }
          >
            {kbState.kind === "ready"
              ? t("ai.kbChunks", { n: kbState.count })
              : kbState.kind === "loading"
                ? t("ai.kbLoading")
                : t("ai.kbErrorShort")}
          </span>
        )}
        <div className="flex-1" />
        {agentMode && (
          <label
            className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-[10px] text-muted"
            title={t("ai.autoRunTitle")}
          >
            <input
              type="checkbox"
              checked={agentAuto}
              onChange={(e) => setAgentAuto(e.target.checked)}
              className="h-3 w-3 accent-[rgb(var(--c-accent))]"
            />
            {t("ai.autoRun")}
          </label>
        )}
      </div>

      {/* Body: history is a floating overlay so it never eats panel width */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {showHistory && (
          <>
            <div className="absolute inset-0 z-20" onClick={() => setShowHistory(false)} />
            <div className="absolute inset-y-0 left-0 z-30 w-48 overflow-hidden rounded-r-xl border-r border-border/70 bg-surface shadow-2xl">
              <SessionList />
            </div>
          </>
        )}

        {multiHost ? (
          <>
            <MultiHostView selected={selectedHosts} onToggle={toggleHost} />
            <Composer
              sessionId={active?.id ?? ""}
              agentMode={agentMode}
              agentAuto={agentAuto}
              multiHost
              selectedHostIds={[...selectedHosts]}
            />
          </>
        ) : active ? (
          <>
            <MessageView
              session={active}
              onInsert={activeTab ? onInsert : undefined}
              onRun={activeTab ? onRun : undefined}
            />
            <Composer
              sessionId={active.id}
              agentMode={agentMode}
              agentAuto={agentAuto}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <span className="icon-chip h-12 w-12">
              <MessageSquare size={20} />
            </span>
            <Button variant="secondary" size="sm" onClick={() => useAiStore.getState().newSession()}>
              <Plus size={13} /> {t("ai.startConversation")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
