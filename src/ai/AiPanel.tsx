import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Activity,
  BookOpen,
  Bot,
  Cable,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAiStore } from "./useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { Markdown } from "./Markdown";
import { writeToTerminal } from "./terminalAi";
import { runAgent } from "./agent";
import { loadKnowledgeBase, kbChunkCount } from "./knowledgeBase";
import { analyzeTerminal, parseSerialProtocol, monitoringInsight } from "./tasks";
import { useTabsStore } from "@/store/useTabsStore";
import type { AIChatSession } from "@/lib/types";

function SessionList() {
  const sessions = useAiStore((s) => s.sessions);
  const activeId = useAiStore((s) => s.activeId);
  const newSession = useAiStore((s) => s.newSession);
  const selectSession = useAiStore((s) => s.selectSession);
  const closeSession = useAiStore((s) => s.closeSession);

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle">
          History
        </span>
        <button
          onClick={() => newSession()}
          title="New chat"
          className="rounded-lg p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <span className="icon-chip h-9 w-9">
              <MessageSquare size={15} />
            </span>
            <p className="text-[11px] leading-relaxed text-subtle">
              No conversations yet.
              <br />
              Tap <Plus size={9} className="inline" /> to start one.
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
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages]);

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {session.messages.length === 0 ? (
        <div className="m-auto flex flex-col items-center gap-4 px-6 py-8 text-center">
          <span className="icon-chip h-12 w-12">
            <Sparkles size={20} />
          </span>
          <div>
            <p className="text-[13px] font-semibold text-fg">AI Assistant</p>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-subtle">
              Ask about Linux ops, SSH, serial or logs — or jump straight in with a quick
              action below.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 self-stretch">
            <button
              onClick={() => analyzeTerminal()}
              className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
            >
              <ScrollText size={14} className="text-accent" />
              <span className="flex-1">Analyze terminal output</span>
              <span className="text-[10px] text-subtle">log</span>
            </button>
            <button
              onClick={() => parseSerialProtocol()}
              className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
            >
              <Cable size={14} className="text-accent" />
              <span className="flex-1">Parse serial protocol</span>
              <span className="text-[10px] text-subtle">serial</span>
            </button>
            <button
              onClick={() => void monitoringInsight()}
              className="flex items-center gap-2 rounded-lg border border-border/70 bg-elevated px-3 py-2 text-left text-[12px] text-fg transition-colors hover:border-accent/40 hover:bg-hover"
            >
              <Activity size={14} className="text-accent" />
              <span className="flex-1">Monitoring insight</span>
              <span className="text-[10px] text-subtle">metrics</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-auto space-y-3">
          {session.messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex items-end gap-2", m.role === "user" ? "justify-end" : "justify-start")}
            >
              {m.role === "assistant" && (
                <span className="icon-chip h-6 w-6 shrink-0">
                  <Sparkles size={12} />
                </span>
              )}
              <div
                className={cn(
                  "max-w-[85%] px-3 py-2 text-[13px] leading-relaxed",
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
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />;
}

function Composer({
  sessionId,
  agentMode,
  agentAuto,
}: {
  sessionId: string;
  agentMode: boolean;
  agentAuto: boolean;
}) {
  const [text, setText] = useState("");
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
    if (agentMode) {
      void runAgent(value, agentAuto);
    } else {
      void send(value);
    }
  };

  return (
    <div className="shrink-0 border-t border-border/70 bg-surface p-3">
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
          placeholder="Message the AI assistant…  (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || streaming}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
          title="Send"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

/** Docked right sidebar AI assistant. Hidden when closed; history is collapsible. */
export function AiPanel() {
  const panelOpen = useAiStore((s) => s.panelOpen);
  const width = useAiStore((s) => s.width);
  const setWidth = useAiStore((s) => s.setWidth);
  const togglePanel = useAiStore((s) => s.togglePanel);
  const activeId = useAiStore((s) => s.activeId);
  const sessions = useAiStore((s) => s.sessions);

  const terminalContext = useAppStore((s) => s.settings.ai.terminalContext);
  const [contextOn, setContextOn] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [agentAuto, setAgentAuto] = useState(false);
  const [kbNote, setKbNote] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadKb = async () => {
    const s = useAppStore.getState().settings.ai;
    if (!s.useKnowledgeBase || !s.knowledgeBasePath?.trim()) {
      window.alert("Enable the knowledge base and set a path in Settings → AI Assistant.");
      return;
    }
    setKbNote("KB: loading…");
    try {
      await loadKnowledgeBase();
      setKbNote(`KB: ${kbChunkCount()} chunks`);
    } catch (e) {
      setKbNote(`KB error: ${String(e)}`);
    }
  };

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeId);
  const activeTab = tabs.find(
    (t) => t.id === activeTabId && t.sessionId && t.kind !== "sftp",
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
      if (window.confirm(`Run this command in “${activeTab.title}”?\n\n${c}`)) {
        writeToTerminal(c, true);
      }
    },
    [activeTab],
  );

  useEffect(() => {
    if (!terminalContext) {
      setContextOn(false);
      return;
    }
    const id = setInterval(() => setContextOn(!!buildContext()), 800);
    return () => clearInterval(id);
  }, [terminalContext, activeId]);

  // Close on Escape.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") togglePanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, togglePanel]);

  if (!panelOpen) return null;

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

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
      className="relative flex h-full shrink-0 flex-col border-l border-border/70 bg-surface"
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-accent/50"
        title="Drag to resize"
      />
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-lg p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
            title={showHistory ? "Collapse chat history" : "Show chat history"}
          >
            {showHistory ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <button
            onClick={() => useAiStore.getState().newSession()}
            className="rounded-lg p-1 text-muted transition-colors hover:bg-hover hover:text-fg"
            title="New chat"
          >
            <Plus size={14} />
          </button>
          <span className="icon-chip h-6 w-6 shrink-0">
            <MessageSquare size={12} />
          </span>
          <span className="truncate text-[13px] font-semibold text-fg">AI Assistant</span>
          {contextOn && (
            <span
              className="pill shrink-0 bg-accent/15 text-accent"
              title="Terminal environment context is attached to your messages"
            >
              context on
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agentMode && (
            <label
              className="mr-0.5 flex cursor-pointer select-none items-center gap-1 text-[10px] text-muted"
              title="Automatically execute agent commands"
            >
              <input
                type="checkbox"
                checked={agentAuto}
                onChange={(e) => setAgentAuto(e.target.checked)}
                className="h-3 w-3 accent-[rgb(var(--c-accent))]"
              />
              auto-run
            </label>
          )}
          <button
            onClick={() => setAgentMode((v) => !v)}
            className={toolBtn(agentMode)}
            title="Agent mode: the model plans and runs commands in the active terminal"
          >
            <Bot size={13} /> Agent
          </button>
          <button
            onClick={() => void loadKb()}
            className={toolBtn(!!(kbNote && !kbNote.includes("error") && kbNote.startsWith("KB:")))}
            title="Load the local knowledge base (path configured in Settings)"
          >
            <BookOpen size={13} /> KB
          </button>
          {kbNote && (
            <span className="max-w-[120px] truncate text-[10px] text-subtle" title={kbNote}>
              {kbNote}
            </span>
          )}
          <button
            onClick={() => togglePanel(false)}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>
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

        {active ? (
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
              <Plus size={13} /> Start a conversation
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
