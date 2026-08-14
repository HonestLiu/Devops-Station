import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Cable,
  ChevronDown,
  ChevronRight,
  Command,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderTree,
  GitBranch,
  ScrollText,
  Search,
  Send,
  Sparkles,
  Square,
  Stethoscope,
  Terminal,
  Wand2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { Tab } from "@/lib/types";
import { localFs } from "@/lib/api";
import { useT } from "@/i18n";
import { useAiStore, hasAiConfig } from "./useAiStore";
import { useAiComposer } from "./useAiComposer";
import { useAiSuggestion } from "./useAiSuggestion";
import { useAiAgent } from "./useAiAgent";
import { runAgent } from "./agent";
import { analyzeTerminal, monitoringInsight, parseSerialProtocol } from "./tasks";
import { Markdown } from "./Markdown";
import { writeToTerminal } from "./terminalAi";
import { scanLocalDir, formatSize } from "./localFs";
import { useSessionStore } from "@/store/useSessionStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useAppStore } from "@/store/useAppStore";

/**
 * Grouped command snippets for the Wand2 "Snippets" flyout. They are *inserted*
 * into the terminal (typed at the prompt) rather than auto-run, so the operator
 * can review before pressing Enter — consistent with how AI-generated commands
 * behave elsewhere.
 */
export const SNIPPET_GROUPS: { group: string; items: { label: string; cmd: string }[] }[] = [
  {
    group: "Git",
    items: [
      { label: "git status (short)", cmd: "git status -s" },
      { label: "recent commits", cmd: "git log --oneline -10" },
      { label: "diff stat", cmd: "git diff --stat" },
      { label: "add + commit", cmd: 'git add . && git commit -m ""' },
      { label: "create branch", cmd: "git checkout -b feature/" },
    ],
  },
  {
    group: "Docker",
    items: [
      { label: "list containers", cmd: "docker ps -a" },
      { label: "compose up", cmd: "docker compose up -d" },
      { label: "list images", cmd: "docker images" },
      { label: "prune system", cmd: "docker system prune -af" },
    ],
  },
  {
    group: "npm / Node",
    items: [
      { label: "install", cmd: "npm install" },
      { label: "run dev", cmd: "npm run dev" },
      { label: "build", cmd: "npm run build" },
      { label: "scaffold vite", cmd: "npx create-vite@latest" },
    ],
  },
  {
    group: "System",
    items: [
      { label: "disk usage by dir", cmd: "du -sh ./* | sort -h" },
      { label: "find large files", cmd: 'find . -type f -size +100M -exec ls -lh {} \\;' },
      { label: "top memory procs", cmd: "ps aux --sort=-%mem | head" },
      { label: "listen ports", cmd: "ss -ltnp" },
    ],
  },
];

/**
 * The inline AI composer: a command-line-style bar docked at the bottom of the
 * terminal. This is the *primary* AI entry point — you ask from within the
 * terminal context, the answer streams back inline, and the side panel is only
 * an "expand" away. It also surfaces a dismissible proactive error hint when the
 * output stream trips a high-signal error pattern.
 */
export function TerminalInlineAsk({ tab }: { tab: Tab }) {
  const t = useT();
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [agentAuto, setAgentAuto] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);
  const [toolsMenuStyle, setToolsMenuStyle] = useState<React.CSSProperties>({});
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // A snippet flyout is only meaningful while the tools menu is open.
  useEffect(() => {
    if (!toolsOpen) setSnippetsOpen(false);
  }, [toolsOpen]);

  const agentRunning = useAiAgent((s) => s.running);
  const agentGoal = useAiAgent((s) => s.goal);
  const agentSteps = useAiAgent((s) => s.steps);
  const agentError = useAiAgent((s) => s.error);
  const agentSummary = useAiAgent((s) => s.summary);
  // Only hide the inline chat answer *while the agent is actively running*; once
  // it finishes the user's chat replies become visible again. (Previously this
  // also depended on `agentSteps.length`, which is never cleared after a run, so
  // every follow-up reply was hidden — making the next task "disappear".)
  const agentActive = agentRunning;
  const agentVisible =
    agentRunning || agentSteps.length > 0 || !!agentError || !!agentSummary;

  const togglePanel = useAiStore((s) => s.togglePanel);
  // The session this composer streams its *own* answers into. Created lazily on
  // first send as a TRANSIENT session — it is never made the active chat
  // session and never appears in the history list, so terminal inline Q&A and
  // the side-panel chat no longer leak into each other (the old code reused the
  // global activeId, mixing both surfaces together).
  const inlineSessionRef = useRef<string | null>(null);
  // Auto-diagnose points the inline bar at its transient session via
  // `displaySessionId`; when set, we show that session's latest assistant
  // message instead of our own.
  const displaySessionId = useAiComposer((s) => s.displaySessionId);
  const [needSetup, setNeedSetup] = useState(false);

  // The latest assistant message to render inline: the diagnose session's
  // answer when one is active, otherwise our own inline session's answer.
  const answer = useAiStore((s) => {
    const sid = displaySessionId ?? inlineSessionRef.current;
    if (!sid) return null;
    const sess = s.sessions.find((x) => x.id === sid);
    if (!sess) return null;
    for (let i = sess.messages.length - 1; i >= 0; i--) {
      if (sess.messages[i].role === "assistant") return sess.messages[i];
    }
    return null;
  });

  const prefill = useAiComposer((s) => s.prefill);
  const autoSend = useAiComposer((s) => s.autoSend);
  const prefillSystem = useAiComposer((s) => s.system);
  // Surface an automatic diagnosis even if the operator never manually opened
  // the composer (flipped by maybeAutoDiagnose when auto-diagnose is enabled).
  const revealAnswer = useAiComposer((s) => s.revealAnswer);
  const suggestion = useAiSuggestion((s) => s.current);
  const clearSuggestion = useAiSuggestion((s) => s.clear);

  const sessionId = useMemo(() => {
    const pane =
      tab.panes && tab.focusedPaneId
        ? tab.panes.find((p) => p.id === tab.focusedPaneId)?.sessionId
        : undefined;
    return pane ?? tab.sessionId ?? null;
  }, [tab]);

  const tabSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (tab.sessionId) ids.add(tab.sessionId);
    tab.panes?.forEach((p) => p.sessionId && ids.add(p.sessionId));
    return ids;
  }, [tab]);

  // Live working directory for local tabs: the OSC 7 hook keeps it fresh in the
  // session store as the user `cd`s; fall back to the spawn-time dir.
  const liveCwd = useSessionStore((s) =>
    sessionId ? s.cwdBySession[sessionId] : undefined,
  );
  const cwd = liveCwd ?? tab.cwd;

  // "Auto-diagnose command errors" toggle (Settings → AI). Surfaced here as a
  // button next to the quick-actions button so the operator can flip it per
  // terminal without opening Settings. Reads/writes the shared AI settings.
  const autoDiagnose = useAppStore((s) => s.settings.ai.autoDiagnose);
  const updateSetting = useAppStore((s) => s.updateSetting);

  // --- Local-shell only: AI actions that read the directory tree ------------
  const explainDirectory = async () => {
    setToolsOpen(false);
    if (!cwd) return;
    const { tree, truncated } = await scanLocalDir(cwd, { maxDepth: 3, maxEntries: 400 });
    const prompt =
      `Explain the structure and likely purpose of the project at:\n${cwd}\n\n` +
      `Directory tree:\n${tree}${truncated ? "\n\n(truncated — too many entries)" : ""}\n\n` +
      `What kind of project is this, what are its main components, and what are the ` +
      `likely build / test / run commands? Be concise.`;
    submitValue(prompt);
  };

  const generateGitignore = async () => {
    setToolsOpen(false);
    if (!cwd) return;
    const { tree } = await scanLocalDir(cwd, { maxDepth: 2, maxEntries: 300 });
    const prompt =
      `Based on the project directory structure below, generate a comprehensive ` +
      `.gitignore for the detected languages and tooling. Output ONLY the .gitignore ` +
      `contents (no explanation, no markdown fences).\n\nDirectory tree:\n${tree}`;
    submitValue(prompt);
  };

  const findLargeFiles = async () => {
    setToolsOpen(false);
    if (!cwd) return;
    const { bySize, truncated } = await scanLocalDir(cwd, { maxDepth: 6, maxEntries: 2500 });
    const top = bySize.slice(0, 25);
    const listing = top.map((f) => `${formatSize(f.size)}\t${f.path}`).join("\n");
    const prompt =
      `These are the largest files under ${cwd}:\n${listing}` +
      `${truncated ? "\n(truncated — more files exist)" : ""}\n\n` +
      `Recommend which of these should be added to .gitignore or safely deleted to ` +
      `free space, and why. Be concise.`;
    submitValue(prompt);
  };

  const submitValue = useCallback(
    (v: string, system?: string) => {
      const t = v.trim();
      if (!t) return;
      if (!hasAiConfig()) {
        setNeedSetup(true);
        return;
      }
      setNeedSetup(false);
      setOpen(true);
      setInput("");
      // A manual question takes over the inline answer area: release any
      // auto-diagnose display binding so the answer rendered here is the
      // response to *this* question, not the previous diagnosis.
      useAiComposer.getState().setDisplaySessionId(null);
      // Lazy-create (or re-create after a purge) the per-composer transient
      // session, then stream into it without touching the global active id.
      let sid = inlineSessionRef.current;
      if (!sid || !useAiStore.getState().sessions.some((s) => s.id === sid)) {
        sid = useAiStore.getState().createTransientSession();
        inlineSessionRef.current = sid;
      }
      void useAiStore.getState().sendToSession(
        sid,
        t,
        system ? { system } : undefined,
      );
    },
    [],
  );

  // Consume pre-filled prompts pushed from elsewhere (selection "Explain",
  // command palette, proactive error hint). Auto-send when requested.
  useEffect(() => {
    if (prefill == null) return;
    if (autoSend) {
      submitValue(prefill, prefillSystem ?? undefined);
    } else {
      setInput(prefill);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    useAiComposer.getState().clear();
  }, [prefill, autoSend, prefillSystem, submitValue]);

  // On unmount: release the auto-diagnose display binding and purge idle
  // transient sessions (agent transcripts, stale inline chats, diagnoses) so
  // they never accumulate in localStorage.
  useEffect(() => {
    return () => {
      useAiComposer.getState().setRevealAnswer(false);
      useAiComposer.getState().setDisplaySessionId(null);
      useAiStore.getState().purgeTransientSessions();
    };
  }, []);

  // Close the tools popover on any click outside it.
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-tools-menu]")) setToolsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [toolsOpen]);

  // Pin the tools popover to the viewport with `fixed` positioning so it is never
  // clipped by the workspace's `overflow-hidden` nor hidden behind the side panel.
  // It opens upward from the button and is clamped inside the viewport.
  useLayoutEffect(() => {
    if (!toolsOpen) return;
    const place = () => {
      const btn = toolsBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const menuW = 208; // matches w-52
      const margin = 8;
      let left = r.left;
      if (left + menuW > window.innerWidth - margin) {
        left = window.innerWidth - menuW - margin;
      }
      if (left < margin) left = margin;
      setToolsMenuStyle({
        position: "fixed",
        left,
        top: r.top,
        transform: "translateY(calc(-100% - 8px))",
        zIndex: 60,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [toolsOpen]);

  const onInsert = useCallback(
    (cmd: string) => writeToTerminal(cmd, false, sessionId),
    [sessionId],
  );
  const onRun = useCallback(
    (cmd: string) => {
      const c = cmd.trim();
      if (!c) return;
      if (window.confirm(`Run this command in “${tab.title}”?\n\n${c}`)) {
        writeToTerminal(c, true, sessionId);
      }
    },
    [tab.title, sessionId],
  );

  const showSuggestion =
    suggestion && tabSessionIds.has(suggestion.sessionId);

  const fixIt = () => {
    const s = useAiSuggestion.getState().current;
    if (!s) return;
    const prompt =
      `The terminal just reported an error:\n\n${s.snippet}\n\n` +
      `What caused it, and what is the exact command(s) to fix it? ` +
      `If a command is needed, put it in a fenced bash block.`;
    clearSuggestion();
    submitValue(prompt);
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      {/* Local-shell current directory: shows the live cwd, lets you open it in
          the OS file manager, copy the path, or spawn a new terminal here. */}
      {tab.kind === "local" && cwd && (
        <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1 text-[11px] text-subtle">
          <FolderOpen size={12} className="shrink-0 text-accent" />
          <span
            className="min-w-0 flex-1 truncate font-mono"
            title={cwd}
          >
            {cwd}
          </span>
          <button
            type="button"
            onClick={() => void localFs.reveal(cwd)}
            className="shrink-0 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.openInFileManager")}
          >
            <ExternalLink size={12} />
          </button>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(cwd)}
            className="shrink-0 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.copyPath")}
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            onClick={() => void useTabsStore.getState().openLocal(cwd)}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.openTerminalHere")}
          >
            <Terminal size={12} />
            <span className="hidden sm:inline">{t("ai.here")}</span>
          </button>
        </div>
      )}

      {/* Inline answer (collapsible) — hidden while the agent runs. Also expands
          automatically on a terminal diagnosis (revealAnswer) so the operator
          sees the cause without opening the composer. */}
      {((open && answer) || revealAnswer) && !agentActive && (
        <div className="max-h-56 overflow-y-auto border-b border-border/70 px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle">
              AI
            </span>
            <div className="flex items-center gap-1">
              {answer?.streaming && (
                <button
                  onClick={() => {
                    const sid = displaySessionId ?? inlineSessionRef.current;
                    if (sid) useAiStore.getState().cancelStream(sid);
                  }}
                  className="flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/20"
                  title={t("ai.stop")}
                >
                  <Square size={10} /> {t("ai.stop")}
                </button>
              )}
              <button
                onClick={() => togglePanel(true)}
                className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
                title={t("ai.openFull")}
              >
                <ArrowUpRight size={13} />
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  useAiComposer.getState().setRevealAnswer(false);
                }}
                className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
                title={t("ai.collapse")}
              >
                <X size={13} />
              </button>
            </div>
          </div>
          {answer?.error ? (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-danger">
              {answer.content || t("ai.requestFailedShort")}
            </p>
          ) : answer?.content ? (
            <Markdown content={answer.content} onInsert={onInsert} onRun={onRun} />
          ) : (
            <span className="inline-flex items-center gap-1 text-subtle">
              <Dot /> <Dot /> <Dot />
              <span className="ml-1">{t("ai.diagnosing")}</span>
            </span>
          )}
          {answer?.streaming && answer?.content && (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
          )}
        </div>
      )}

      {/* AI not configured: show a one-line setup hint instead of silently
          dropping the request. */}
      {needSetup && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-warning/10 px-3 py-1.5">
          <AlertTriangle size={13} className="shrink-0 text-warning" />
          <span className="truncate text-[12px] text-fg">{t("ai.needSetup")}</span>
          <button
            onClick={() => {
              setNeedSetup(false);
              useAppStore.getState().setPage("settings");
            }}
            className="ml-auto shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90"
          >
            {t("ai.goSettings")}
          </button>
          <button
            type="button"
            onClick={() => setNeedSetup(false)}
            className="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.dismiss")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Inline agent progress (launched from the bar) */}
      {agentVisible && (
        <AgentBlock
          goal={agentGoal}
          running={agentRunning}
          steps={agentSteps}
          error={agentError}
          summary={agentSummary}
          onClear={() => useAiAgent.getState().reset()}
          onInsert={onInsert}
          onRun={onRun}
        />
      )}

      {/* Proactive error hint */}
      {showSuggestion && (
        <div className="flex items-center gap-2 border-b border-border/70 bg-warning/10 px-3 py-1.5">
          <AlertTriangle size={13} className="shrink-0 text-warning" />
          <span className="truncate text-[12px] text-fg">{suggestion!.label}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              onClick={fixIt}
              className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90"
            >
              Let AI fix
            </button>
            <button
              onClick={clearSuggestion}
              className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
              title={t("ai.dismiss")}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (agentMode) {
            const goal = input.trim();
            if (!goal) return;
            if (!hasAiConfig()) {
              setNeedSetup(true);
              return;
            }
            setNeedSetup(false);
            setInput("");
            // Keep agent mode ON after a run, so consecutive tasks don't require
            // re-toggling the 🤖 button every time. The operator can still turn it
            // off manually via the button.
            requestAnimationFrame(() => inputRef.current?.focus());
            void runAgent(goal, agentAuto, true, sessionId);
          } else {
            submitValue(input);
          }
        }}
        className="relative flex items-center gap-2 px-3 py-2"
      >
        {/* Quick actions: stream back inline instead of opening the panel */}
        <div className="relative" data-tools-menu>
          <button
            type="button"
            ref={toolsBtnRef}
            onClick={() => setToolsOpen((v) => !v)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.quickActions")}
          >
            <Wand2 size={14} />
          </button>
          {toolsOpen && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              style={toolsMenuStyle}
              className="w-52 rounded-lg border border-border bg-surface p-1 shadow-xl"
            >
              <ToolItem
                icon={<ScrollText size={13} />}
                label={t("ai.analyzeTerminal")}
                onClick={() => {
                  setToolsOpen(false);
                  analyzeTerminal(true);
                }}
              />
              <ToolItem
                icon={<Cable size={13} />}
                label={t("ai.parseSerial")}
                onClick={() => {
                  setToolsOpen(false);
                  parseSerialProtocol(true);
                }}
              />
              <ToolItem
                icon={<Activity size={13} />}
                label={t("ai.monitoringInsight")}
                onClick={() => {
                  setToolsOpen(false);
                  void monitoringInsight(undefined, true);
                }}
              />

              <div className="my-1 h-px bg-border/70" />

              {/* Snippets: a flyout of grouped command snippets (insert, not run). */}
              <div
                className="relative"
                onMouseEnter={() => setSnippetsOpen(true)}
              >
                <ToolItem
                  icon={<Command size={13} />}
                  label={t("ai.snippets")}
                  onClick={() => setSnippetsOpen((v) => !v)}
                />
                {snippetsOpen && (
                  <div className="absolute left-full top-0 z-10 max-h-72 w-52 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl">
                    {SNIPPET_GROUPS.map((g) => (
                      <div key={g.group} className="mb-1">
                        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                          {g.group}
                        </div>
                        {g.items.map((it) => (
                          <button
                            key={it.label}
                            type="button"
                            onClick={() => {
                              setToolsOpen(false);
                              onInsert(it.cmd);
                            }}
                            className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover"
                            title={it.cmd}
                          >
                            <ChevronRight size={11} className="shrink-0 text-subtle" />
                            <span className="flex-1 truncate">{it.label}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Local-shell only: AI actions that read the cwd's directory tree. */}
              {tab.kind === "local" && cwd && (
                <>
                  <div className="my-1 h-px bg-border/70" />
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Local files
                  </div>
                  <ToolItem
                    icon={<FolderTree size={13} />}
                    label={t("ai.explainDir")}
                    onClick={() => void explainDirectory()}
                  />
                  <ToolItem
                    icon={<GitBranch size={13} />}
                    label={t("ai.gitignore")}
                    onClick={() => void generateGitignore()}
                  />
                  <ToolItem
                    icon={<Search size={13} />}
                    label={t("ai.largeFiles")}
                    onClick={() => void findLargeFiles()}
                  />
                </>
              )}
            </div>
          )}
        </div>

        {/* Auto-diagnose toggle — sits next to the quick-actions button. When
            on, a terminal error automatically asks the AI for the cause and
            streams the diagnosis to the bottom panel (see Terminal.tsx). */}
        <button
          type="button"
          onClick={() =>
            void updateSetting("ai", {
              ...useAppStore.getState().settings.ai,
              autoDiagnose: !autoDiagnose,
            })
          }
          aria-pressed={autoDiagnose}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
            autoDiagnose
              ? "bg-accent text-accent-fg"
              : "text-subtle hover:bg-hover hover:text-fg",
          )}
          title={t("settings.autoDiagnose")}
        >
          <Stethoscope size={14} />
        </button>

        {/* Agent toggle — launches the autonomous loop inline */}
        <button
          type="button"
          onClick={() => setAgentMode((v) => !v)}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
            agentMode
              ? "bg-accent text-accent-fg"
              : "text-subtle hover:bg-hover hover:text-fg",
          )}
          title={t("ai.agentModeTitle")}
        >
          <Bot size={14} />
        </button>

        <Sparkles size={14} className="shrink-0 text-accent" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            agentMode ? t("ai.agentPlaceholder") : t("ai.askPlaceholder")
          }
          className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-subtle"
        />
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
            {t("ai.auto")}
          </label>
        )}
        <button
          type="button"
          onClick={() => togglePanel(true)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
          title={t("ai.openFull")}
        >
          <ArrowUpRight size={14} />
        </button>
        <button
          type="submit"
          disabled={!input.trim()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
          title={t("ai.send")}
        >
          <Send size={13} />
        </button>
      </form>
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />;
}

/**
 * Compact, same-view rendering of an inline agent run. Shows the goal, a live
 * "working" pulse, and each step (the command + the output it produced) with
 * inline insert/run. This is what replaces opening the side panel for agent work.
 */
function AgentBlock({
  goal,
  running,
  steps,
  error,
  summary,
  onClear,
  onInsert,
  onRun,
}: {
  goal: string;
  running: boolean;
  steps: { cmd: string; result: string; status: string }[];
  error: string | null;
  summary: string | null;
  onClear: () => void;
  onInsert: (c: string) => void;
  onRun: (c: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border-b border-border/70 bg-accent/5">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Bot size={13} className="shrink-0 text-accent" />
        <span className="truncate text-[12px] text-fg">
          {running ? t("ai.agentWorking") : t("ai.agent")}
          {goal && <span className="text-subtle"> · {goal}</span>}
        </span>
        {running && (
          <span className="inline-flex gap-1 text-accent">
            <Dot /> <Dot /> <Dot />
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={expanded ? t("ai.collapse") : t("ai.expand")}
          >
            <ChevronDown size={12} className={cn(!expanded && "rotate-180")} />
          </button>
          <button
            type="button"
            onClick={onClear}
            className="rounded p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            title={t("ai.clear")}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="max-h-52 space-y-2 overflow-y-auto px-3 pb-2">
          {error && <p className="whitespace-pre-wrap text-[12px] text-danger">{error}</p>}
          {steps.map((s, i) => (
            <div key={i} className="rounded-md border border-border/60 bg-bg p-2">
              <div className="flex items-center gap-1">
                <code className="flex-1 truncate font-mono text-[11px] text-fg">$ {s.cmd}</code>
                <button
                  type="button"
                  onClick={() => onInsert(s.cmd)}
                  className="rounded p-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
                  title={t("ai.insertIntoTerminal")}
                >
                  <ArrowUpRight size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => onRun(s.cmd)}
                  className="rounded p-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
                  title={t("ai.runInTerminal")}
                >
                  <Send size={11} />
                </button>
              </div>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-muted">
                {s.result}
              </pre>
            </div>
          ))}
          {summary && !running && (
            <div className="rounded-md border border-accent/30 bg-accent/5 p-2">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                <Bot size={11} /> {t("ai.agentSummary")}
              </div>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">
                {summary}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover"
    >
      <span className="text-subtle">{icon}</span>
      {label}
    </button>
  );
}
