import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BookOpen, Bot, MessageSquare, Plus, Send, PanelRightClose, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAiStore } from "./useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { Markdown } from "./Markdown";
import { writeToTerminal } from "./terminalAi";
import { runAgent } from "./agent";
import { loadKnowledgeBase, kbChunkCount } from "./knowledgeBase";
import { useTabsStore } from "@/store/useTabsStore";
import type { AIChatSession } from "@/lib/types";

function SessionList() {
  const sessions = useAiStore((s) => s.sessions);
  const activeId = useAiStore((s) => s.activeId);
  const newSession = useAiStore((s) => s.newSession);
  const selectSession = useAiStore((s) => s.selectSession);
  const closeSession = useAiStore((s) => s.closeSession);

  return (
    <div className="flex w-40 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between px-2 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          Chats
        </span>
        <button
          onClick={() => newSession()}
          title="New chat"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
        {sessions.length === 0 && (
          <p className="px-1.5 py-2 text-[11px] text-subtle">
            No conversations yet.
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => selectSession(s.id)}
            className={cn(
              "group flex cursor-pointer items-center justify-between gap-1 rounded px-2 py-1.5 text-[12px]",
              s.id === activeId
                ? "bg-accent/15 text-fg"
                : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <span className="truncate">{s.title || "New chat"}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
              className="opacity-0 group-hover:opacity-100 hover:text-red-400"
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
    <div className="flex-1 space-y-3 overflow-y-auto p-3">
      {session.messages.length === 0 && (
        <div className="mt-8 text-center text-[12px] text-subtle">
          Ask about Linux ops, SSH, serial debugging, log analysis…
        </div>
      )}
      {session.messages.map((m) => (
        <div
          key={m.id}
          className={cn(
            "flex",
            m.role === "user" ? "justify-end" : "justify-start",
          )}
        >
          <div
            className={cn(
              "max-w-[90%] rounded-lg px-3 py-2 text-[13px]",
              m.role === "user"
                ? "bg-accent/15 text-fg"
                : m.error
                  ? "border border-red-500/40 bg-red-500/10 text-red-300"
                  : "bg-elevated text-fg",
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
    <div className="border-t border-border p-2">
      <div className="flex items-end gap-2 rounded-lg border border-border bg-bg p-2 focus-within:border-accent/50">
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
          className="rounded-md bg-accent px-2.5 py-1.5 text-accent-fg disabled:opacity-40"
          title="Send"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

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

  return (
    <div
      className="relative flex h-full shrink-0 border-l border-border bg-surface"
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
        title="Drag to resize"
      />
      <SessionList />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <MessageSquare size={14} />
            <span className="font-medium text-fg">AI Assistant</span>
            {contextOn && (
              <span
                className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
                title="Terminal environment context is attached to your messages"
              >
                context on
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {agentMode && (
              <label
                className="flex cursor-pointer select-none items-center gap-1 text-[10px] text-muted"
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
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-1 text-[11px]",
                agentMode
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
              title="Agent mode: the model plans and runs commands in the active terminal"
            >
              <Bot size={13} /> Agent
            </button>
            <button
              onClick={() => void loadKb()}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-1 text-[11px]",
                kbNote?.startsWith("KB:") && !kbNote.includes("error")
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
              title="Load the local knowledge base (path configured in Settings)"
            >
              <BookOpen size={13} /> KB
            </button>
            {kbNote && (
              <span className="max-w-[140px] truncate text-[10px] text-subtle" title={kbNote}>
                {kbNote}
              </span>
            )}
            <button
              onClick={() => togglePanel(false)}
              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
              title="Close panel"
            >
              <PanelRightClose size={15} />
            </button>
          </div>
        </div>
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
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-subtle">
            <MessageSquare size={28} />
            <button
              onClick={() => useAiStore.getState().newSession()}
              className="flex items-center gap-1.5 rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] text-fg hover:bg-hover"
            >
              <Plus size={13} /> Start a conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
