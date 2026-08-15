import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ITheme } from "@xterm/xterm";
import { ClipboardPaste, Command, Copy, Eraser, Sparkles, TextSelect } from "lucide-react";

import { ssh, pty, localFs, notify } from "@/lib/api";
import { dataLink } from "@/lib/dataLink";
import { useT } from "@/i18n";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { base64ToBytes, textToBase64 } from "@/lib/utils";
import type { Attached, SessionClosed, StreamChunk } from "@/lib/types";
import { useSessionStore } from "@/store/useSessionStore";
import { useAppStore } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import { isBenignContext, isWaitingForInput, scanForError, errorFingerprint } from "@/ai/errorScan";
import { maybeAutoDiagnose } from "@/ai/diagnose";
import { useAiSuggestion } from "@/ai/useAiSuggestion";
import { useAiComposer } from "@/ai/useAiComposer";
import { EXPLAIN_SYSTEM, FIX_SYSTEM, GENERATE_SYSTEM, writeToTerminal } from "@/ai/terminalAi";
import { SNIPPET_GROUPS } from "@/ai/TerminalInlineAsk";
import { registerTerminal, unregisterTerminal, useTerminalSelection } from "@/ai/terminalBridge";
import { SelectionMenu } from "@/ai/SelectionMenu";

// Snippets submenu — mirrors the "Snippets" flyout in the terminal's AI bar. Each
// group becomes its own nested submenu (e.g. "Snippets → Git → <command>") so the
// top-level entry stays short. Every command is *inserted* into the active
// terminal for review (not auto-run), via the same `writeToTerminal(cmd, false)`
// path the flyout uses.
const SNIPPET_MENU: MenuItem[] = SNIPPET_GROUPS.map((g) => ({
  id: `snip-group-${g.group}`,
  label: g.group,
  submenu: g.items.map((it) => ({
    id: `snip-${g.group}-${it.label}`,
    label: it.label,
    onClick: () => writeToTerminal(it.cmd, false),
  })),
}));

// --- Proactive error-diagnosis deduplication ----------------------------------
//
// The terminal data stream re-scans its 2000-char tail on *every* chunk, so a
// single error line can be re-detected dozens of times as it scrolls, is
// redrawn, or lingers in the window while other commands run. All deduplication
// therefore happens HERE, at the only call site that feeds the two downstream
// channels (auto-diagnose + "let AI fix" hint) — not in each channel's own
// cooldown (the old approach keyed on `(sessionId, label)` with short windows,
// so reconnecting to a new session id or the same error printing again after
// 10s re-triggered everything).
//
// The key is an error *fingerprint* (normalised snippet, see errorScan.ts), and
// the window is global across terminals: "exit and reconnect" within the window
// produces a new session id but the same error — which must NOT re-trigger.
/** Any one error fingerprint is surfaced at most once per window, app-wide. */
const ERROR_DEDUP_WINDOW_MS = 60_000;
/** Cap before pruning stale entries so the map never grows unbounded. */
const ERROR_DEDUP_MAX = 128;
const handledErrors = new Map<string, number>();

function shouldHandleError(fingerprint: string, now: number): boolean {
  const prev = handledErrors.get(fingerprint) ?? 0;
  if (now - prev < ERROR_DEDUP_WINDOW_MS) return false;
  handledErrors.set(fingerprint, now);
  if (handledErrors.size > ERROR_DEDUP_MAX) {
    for (const [k, ts] of handledErrors) {
      if (now - ts >= ERROR_DEDUP_WINDOW_MS) handledErrors.delete(k);
    }
  }
  return true;
}

export interface TerminalProps {
  sessionId: string;
  transport: "ssh" | "pty" | "serial" | "ble";
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  /** When false, input is ignored (e.g. while reconnecting). */
  interactive?: boolean;
  /** Fired when the remote side hangs up, so the tab can stop saying "connected". */
  onClosed?: (info: SessionClosed) => void;
  /** When true, capture the shell's working directory over OSC 7 and ask the
   *  shell to emit it on every prompt (SSH and WSL sessions). */
  trackCwd?: boolean;
  /** Shell kind for local PTY sessions, used to pick the right OSC 7 emitter.
   *  Omit for SSH/WSL (POSIX remote, treated as bash/zsh). */
  shell?: string;
}

/**
 * Build the per-prompt OSC 7 setup command for the given shell. Returns null
 * when the shell is unknown / unsupported so we inject nothing instead of
 * feeding bash syntax into powershell/cmd/fish (which would error at startup).
 *
 * `shell` is the *resolved* shell (e.g. "pwsh.exe", "/bin/zsh", "fish") — we
 * normalize it (basename, lowercase, strip ".exe") so both the raw `$SHELL`
 * path the backend returns and a user-picked "powershell" match correctly.
 */
function buildCwdSetup(shell: string | undefined): string | null {
  const s = normalizeShell(shell);
  if (s === "powershell" || s === "pwsh") {
    // Hook PowerShell's prompt to emit `OSC 7` on every prompt, preserving the
    // user's existing prompt via $function:prompt. [Console]::Write keeps the
    // escape sequence on the raw PTY stream (Write-Host can be swallowed).
    //
    // IMPORTANT: emit this as a SINGLE line terminated by a bare CR (`\r`).
    // Two traps here, both verified against PSReadLine:
    //   1. A multi-line `function {…}` block is parsed as an unterminated code
    //      block and leaves the shell stuck at the ">>" continuation prompt.
    //   2. CRLF is *not* safe either: PSReadLine submits the line on CR, then
    //      the trailing bare LF lands *inside* the next input line — it
    //      re-parses the buffer and drops into ">>" again right after the
    //      prompt. CR is the only byte PSReadLine treats as Enter; LF must not
    //      be sent at all.
    return (
      "function global:__ds_cwd {$h=[System.Net.Dns]::GetHostName();$p=(Get-Location).Path.Replace('\\','/');[Console]::Write([char]27 + \"]7;file://\" + $h + \"/\" + $p + [char]27 + [char]92)}" +
      ";$__ds_old_prompt=$function:prompt;function prompt{__ds_cwd;& $__ds_old_prompt};__ds_cwd" +
      "\r"
    );
  }
  if (s === "fish") {
    // fish has no PROMPT_COMMAND; hook the `fish_prompt` event which fires before
    // every prompt. Emitted as a single line so the interactive parser doesn't
    // get stuck in a continuation state.
    return (
      "function __ds_cwd --on-event fish_prompt; printf '\\033]7;file://%s%s\\033\\\\' (hostname) (pwd | string replace -a ' ' '%20'); end; __ds_cwd\n"
    );
  }
  if (
    s === "bash" ||
    s === "git-bash" ||
    s === "zsh" ||
    s === "sh" ||
    s === "dash" ||
    s === "ash"
  ) {
    // POSIX shell: self-detects bash (PROMPT_COMMAND) vs zsh (precmd). Covers
    // bash, zsh, and the various Bourne derivatives (sh/dash/ash) — for the
    // latter PROMPT_COMMAND may be absent, in which case OSC 7 simply won't
    // fire (inert), but the shell stays usable.
    return (
      "__ds_cwd(){ printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }; " +
      "if [ -n \"$BASH_VERSION\" ]; then PROMPT_COMMAND=\"${PROMPT_COMMAND:+${PROMPT_COMMAND}; }__ds_cwd\"; " +
      "elif [ -n \"$ZSH_VERSION\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __ds_cwd; fi\n"
    );
  }
  // cmd / empty / unknown → stay inert (no injection) so we never crash the
  // shell on startup. The cwd bar simply falls back to the spawn-time dir.
  return null;
}

/** Normalize a shell identifier to a comparable key: take the basename,
 * lowercase it, and strip a trailing ".exe" (handles `/bin/zsh`,
 * `C:\…\powershell.exe`, `pwsh.exe`, …). */
function normalizeShell(shell: string | undefined): string {
  if (!shell) return "";
  const base = shell.includes("/") || shell.includes("\\")
    ? shell.split(/[\\/]/).pop()!
    : shell;
  return base.toLowerCase().replace(/\.exe$/i, "");
}

type TransportApi = {
  onData: (sessionId: string, cb: (c: StreamChunk) => void) => Promise<UnlistenFn>;
  write: (sessionId: string, data: string) => Promise<void>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  onClosed: (sessionId: string, cb: (info: SessionClosed) => void) => Promise<UnlistenFn>;
  attach: (sessionId: string) => Promise<Attached>;
};

/**
 * Single xterm.js surface shared by SSH and local PTY sessions. Bytes cross the
 * Tauri IPC boundary base64-encoded, so every chunk is decoded to a Uint8Array
 * before `write` and re-encoded on the way out — this keeps invalid UTF-8
 * (a board mid-boot, a binary cat) from corrupting the stream.
 */
export function Terminal(props: TerminalProps) {
  const t = useT();
  const {
    sessionId,
    transport,
    theme,
    fontFamily,
    fontSize,
    lineHeight,
    cursorBlink,
    cursorStyle,
    scrollback,
    interactive = true,
    onClosed,
    trackCwd = false,
    shell,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const closedRef = useRef(false);
  // Recent decoded output for the lightweight proactive-error scan. We keep a
  // small tail so cross-chunk errors are still caught without scanning forever.
  const recentRef = useRef("");
  // Whether the current tail looks like a "waiting for input" prompt. Tracked in
  // a ref so we only act on transitions (avoid thrashing the shared store).
  const waitingRef = useRef(false);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // Kept in a ref so a changing callback never re-runs the session effect.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  // Whether THIS terminal is the one the user is currently working in (active
  // tab + focused pane). All tab workspaces stay mounted (inactive tabs are
  // merely hidden), so focus can only be grabbed by the terminal that is
  // actually visible and focused — everything else must stay untouched.
  const isActive = useTabsStore((s) => {
    const t = s.tabs.find(
      (tt) =>
        tt.sessionId === sessionId || !!tt.panes?.some((p) => p.sessionId === sessionId),
    );
    if (!t || t.id !== s.activeId) return false;
    const panes = t.panes;
    if (!panes || panes.length === 0) return true; // single-pane tab
    const mine = panes.find((p) => p.sessionId === sessionId);
    return mine ? mine.id === (t.focusedPaneId ?? panes[0].id) : t.sessionId === sessionId;
  });

  // Right-click menu: copy / paste / select-all / clear, operating directly on the
  // xterm instance. stopPropagation keeps the app-level default menu from also
  // firing (and we still preventDefault to kill the native OS menu).
  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);
  const onTermContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const term = termRef.current;
    if (!term) return;
    const sel = (term.getSelection() ?? "").trim();
    const items: MenuItem[] = [
      {
        id: "copy",
        label: t("term.copy"),
        icon: <Copy size={14} />,
        disabled: !term.hasSelection(),
        onClick: () => {
          const sel = term.getSelection();
          if (sel) navigator.clipboard?.writeText(sel).catch(() => undefined);
        },
      },
      {
        id: "paste",
        label: t("term.paste"),
        icon: <ClipboardPaste size={14} />,
        onClick: () => {
          navigator.clipboard?.readText().then((t) => {
            if (t) term.paste(t);
          }).catch(() => undefined);
        },
      },
      { id: "sep", separator: true, label: "" },
      {
        id: "select-all",
        label: t("term.selectAll"),
        icon: <TextSelect size={14} />,
        onClick: () => term.selectAll(),
      },
      { id: "sep-snip", separator: true, label: "" },
      {
        id: "snippets",
        label: t("term.snippets"),
        icon: <Command size={14} />,
        submenu: SNIPPET_MENU,
      },
      {
        id: "clear",
        label: t("term.clear"),
        icon: <Eraser size={14} />,
        onClick: () => {
          term.clear();
          term.focus();
        },
      },
    ];

    // When the user has box-selected text, surface the same AI actions the
    // floating selection icon offers — directly inside the right-click menu so
    // the icon becomes optional, not required.
    if (sel) {
      items.push(
        { id: "sep-ai", separator: true, label: "" },
        {
          id: "ai-explain",
          label: t("term.aiExplain"),
          icon: <Sparkles size={14} />,
          onClick: () =>
            useAiComposer.getState().setPrefill(
              `Explain the following terminal selection:\n\n${sel}`,
              true,
              EXPLAIN_SYSTEM,
            ),
        },
        {
          id: "ai-fix",
          label: t("term.aiFix"),
          icon: <Sparkles size={14} />,
          onClick: () =>
            useAiComposer.getState().setPrefill(
              `Here is the terminal excerpt:\n\n${sel}\n\nWhat went wrong and how do I fix it?`,
              true,
              FIX_SYSTEM,
            ),
        },
        {
          id: "ai-generate",
          label: t("term.aiCommand"),
          icon: <Sparkles size={14} />,
          onClick: () =>
            useAiComposer.getState().setPrefill(
              `Turn the following into the shell command(s) I should run:\n\n${sel}`,
              true,
              GENERATE_SYSTEM,
            ),
        },
      );
    }

    showCtx(e.clientX, e.clientY, items);
  };

  // Drag-and-drop a local file onto the terminal to type its path at the prompt.
  const [dragActive, setDragActive] = useState(false);

  // --- lifecycle ----------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api: TransportApi =
      transport === "ssh"
        ? ssh
        : transport === "pty"
          ? pty
          : (dataLink(transport === "ble" ? "ble" : "serial") as unknown as TransportApi);

    const term = new XTerm({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink,
      cursorStyle,
      scrollback,
      theme,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new Unicode11Addon());
    // Terminal links open in the OS browser on **Ctrl/Cmd+click**. A plain
    // click is left alone so it can't hijack terminal selection/interaction.
    // (macOS reserves Ctrl+click as right-click, so use Cmd+click there.)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) {
          // xterm.js may include a trailing backslash or CR as part of the
          // linkified text (common when a URL is printed before a line break).
          // Strip those so the OS does not treat the URL as a local path.
          const clean = uri.trim().replace(/[\\\r\n]+$/g, "");
          if (clean) void localFs.openUrl(clean).catch(() => undefined);
        }
      }),
    );
    term.open(host);
    fit.fit();

    // For SSH sessions, capture the remote shell's working directory via the
    // OSC 7 sequence (file://host/path) that we ask the shell to emit on every
    // prompt. The SFTP panel reads this from the session store to follow `cd`.
    let oscDisposable: { dispose: () => void } | undefined;
    if (trackCwd) {
      oscDisposable = term.parser.registerOscHandler(7, (data: string) => {
        const m = /^file:\/\/[^/]*(.*)$/.exec(data);
        if (m && m[1]) {
          let path = decodeURIComponent(m[1]);
          // OSC 7 for Windows paths arrives as /C:/Users/... — strip the leading
          // slash so it becomes a valid Windows path (C:/Users/...).
          if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
          useSessionStore.getState().setCwd(sessionId, path);
        }
        return true;
      });
    }

    termRef.current = term;
    fitRef.current = fit;
    closedRef.current = false;

    // Expose the xterm instance so other surfaces (AI "explain selection",
    // command palette) can read the current selection.
    registerTerminal(sessionId, term);
    const onSel = term.onSelectionChange(() => {
      useTerminalSelection.getState().setText(term.getSelection(), sessionId);
    });

    const onData = term.onData((data) => {
      if (!interactiveRef.current || closedRef.current) return;
      void api.write(sessionId, textToBase64(data));
    });

    // --- attach handshake ---------------------------------------------------
    // The session is already producing output by the time this component
    // mounts. Register the listeners first, then ask the backend to flush what
    // it buffered; doing it the other way around silently drops the shell
    // banner and the first prompt, leaving a terminal that looks dead.
    //
    // The invoke response and the event stream are separate IPC channels with
    // no ordering guarantee between them, so live chunks are parked until the
    // backlog has been written — otherwise the prompt could land *before* the
    // banner it followed.
    let disposed = false;
    let flushed = false;
    const parked: Uint8Array[] = [];
    const unlisteners: UnlistenFn[] = [];

    const markClosed = (info: SessionClosed) => {
      closedRef.current = true;
      onClosedRef.current?.(info);
    };

    void (async () => {
      try {
        const stopData = await api.onData(sessionId, (chunk: StreamChunk) => {
          if (disposed) return;
          const bytes = base64ToBytes(chunk.data);
          if (!flushed) {
            parked.push(bytes);
          } else {
            term.write(bytes);
          }
          // (A) Waiting-for-input detection — ALWAYS on (not gated by the AI
          // error-hint setting): it drives the tab "waiting" badge, the bell
          // panel and the Ctrl+Shift+Enter quick-approval shortcut, all of
          // which must work even when the user disabled AI error hints.
          try {
            const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
            if (text) {
              recentRef.current = (recentRef.current + text).slice(-2000);
              const waiting = isWaitingForInput(recentRef.current);
              if (waiting !== waitingRef.current) {
                waitingRef.current = waiting;
                useSessionStore.getState().setWaiting(sessionId, waiting);
              }
            }
          } catch {
            /* decode/scan must never break the terminal stream */
          }
          // (B) Proactive error detection: scan decoded output for high-signal
          // errors. Two modes, both gated by Settings → AI:
          //   • errorHints  → show a dismissible "let AI fix it?" prompt
          //   • autoDiagnose → automatically ask the AI and stream the cause to
          //     the bottom panel (no manual click). autoDiagnose wins when both
          //     are on, so the operator never gets the click prompt *and* an
          //     auto-run for the same error.
          //
          // Two hard gates prevent the "keyword → repeated triggers" reports:
          //   1. Only scan AFTER the attach backlog has been flushed. While
          //      `flushed` is false we are replaying buffered output from before
          //      this terminal attached (a shell banner, the tail of a previous
          //      session, an agent CLI's startup text) — none of it is a fresh
          //      command error, and on "exit and reconnect" it was the #1 source
          //      of an immediate duplicate diagnosis.
          //   2. Deduplicate by error fingerprint with a global window. The
          //      same error line is re-detected many times while it stays in
          //      the 2000-char tail; only the first detection per window is
          //      surfaced (to whichever channel is active).
          const aiSettings = useAppStore.getState().settings.ai;
          if (
            flushed &&
            (aiSettings.errorHints || aiSettings.autoDiagnose)
          ) {
            try {
              const hit = scanForError(recentRef.current);
              // High-signal shell errors (mistyped command, permission denied,
              // missing file) always surface, even if an interactive-prompt marker
              // (PSReadLine "did you mean" block, agent confirm dialog) is also on
              // screen — isBenignContext would otherwise silence them and the user
              // would see nothing. Softer/generic errors still respect the guard.
              if (hit && (!isBenignContext(recentRef.current) || hit.highSignal)) {
                if (shouldHandleError(errorFingerprint(hit), Date.now())) {
                  if (aiSettings.autoDiagnose) {
                    maybeAutoDiagnose(sessionId, hit, recentRef.current);
                  } else {
                    useAiSuggestion.getState().offer({
                      sessionId,
                      label: hit.label,
                      snippet: hit.snippet,
                    });
                  }
                }
              } else if (isBenignContext(recentRef.current)) {
                // An interactive prompt / agent banner is on screen (e.g.
                // Claude Code's "trust this folder?" confirm). Drop any
                // sticky "let AI fix" hint so a transient false positive from
                // the startup text can never linger over the dialog.
                useAiSuggestion.getState().clear();
              }
            } catch {
              /* decode/scan must never break the terminal stream */
            }
          }
        });
        if (disposed) return void stopData();
        unlisteners.push(stopData);

        const stopClosed = await api.onClosed(sessionId, (info) => {
          if (disposed) return;
          markClosed(info);
        });
        if (disposed) return void stopClosed();
        unlisteners.push(stopClosed);

        const pending = await api.attach(sessionId);
        if (disposed) return;
        if (pending.backlog) term.write(base64ToBytes(pending.backlog));
        flushed = true;
        for (const bytes of parked) term.write(bytes);
        parked.length = 0;
        if (pending.closed) markClosed(pending.closed);

        // Ask the shell to report its working directory on every prompt via an
        // OSC 7 escape, so the cwd bar / SFTP follow stays in sync with `cd`.
        // The exact snippet depends on the shell — feeding bash syntax into
        // powershell/cmd would error on startup, so buildCwdSetup stays inert
        // for shells we can't safely drive.
        if (trackCwd) {
          const setup = buildCwdSetup(shell);
          if (setup) {
            void api.write(sessionId, textToBase64(setup)).catch(() => undefined);
          }
        }
      } catch {
        // The session can vanish between mount and attach (fast disconnect).
        // The workspace overlay already reports that, so stay quiet here.
      }
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const dims = term.rows && term.cols ? { cols: term.cols, rows: term.rows } : null;
        if (dims && (transport === "ssh" || transport === "pty")) {
          void api.resize(sessionId, dims.cols, dims.rows).catch(() => undefined);
        }
      } catch {
        /* fit can throw if the element isn't measurable yet */
      }
    });
    ro.observe(host);

    // Drag a local file onto the terminal to insert its (quoted) path at the
    // prompt. Skipped for serial sessions where a path is meaningless. The Tauri
    // drag event is window-global (same pattern as the SFTP/WSL panels); only
    // terminal tabs mount this component, so it never collides with their upload
    // handlers.
    let unDrag: UnlistenFn | undefined;
    let dragDisposed = false;
    if (transport !== "serial" && transport !== "ble") {
      void import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) => {
          if (dragDisposed) return;
          const p = getCurrentWebview().onDragDropEvent((event) => {
            const e = event.payload;
            if (e.type === "drop") {
              setDragActive(false);
              if (e.paths.length) {
                const typed = e.paths
                  .map((p) => (p.includes(" ") ? `"${p}"` : p))
                  .join(" ");
                void api.write(sessionId, textToBase64(typed + " ")).catch(() => undefined);
              }
            } else if (e.type === "leave") {
              setDragActive(false);
            } else {
              setDragActive(true);
            }
          });
          p.then((fn) => {
            if (dragDisposed) fn();
            else unDrag = fn;
          }).catch(() => undefined);
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
      dragDisposed = true;
      unDrag?.();
      ro.disconnect();
      onData.dispose();
      onSel.dispose();
      oscDisposable?.dispose();
      for (const stop of unlisteners) stop();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      unregisterTerminal(sessionId);
      if (transport === "ssh") useSessionStore.getState().clearCwd(sessionId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, transport]);

  // Grab keyboard focus when this terminal becomes the active one: on mount
  // (newly opened tab / pane), on tab switch, and on split-pane focus changes.
  // Defined AFTER the lifecycle effect so `termRef` is populated on first run.
  useEffect(() => {
    if (isActive) termRef.current?.focus();
  }, [isActive, sessionId]);

  // --- live option updates ------------------------------------------------
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.lineHeight = lineHeight;
    term.options.cursorBlink = cursorBlink;
    term.options.cursorStyle = cursorStyle;
    term.options.scrollback = scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [theme, fontFamily, fontSize, lineHeight, cursorBlink, cursorStyle, scrollback]);

  // Show the "Explain" affordance only when this terminal owns a non-empty selection.
  const selText = useTerminalSelection((s) =>
    s.sessionId === sessionId ? s.text : "",
  );

  // In-app drag (e.g. a file dragged from the Files sidebar): the Tauri
  // onDragDropEvent only fires for OS-level drags, so we also accept the HTML5
  // drop here and type the (quoted) path at the prompt.
  const handleFileDrop = (e: DragEvent<HTMLDivElement>) => {
    if (transport === "serial" || transport === "ble") return;
    const data = e.dataTransfer.getData("text/plain");
    // Ignore tab-bar drags: they carry a tab id (tab-N) as text/plain and must
    // not be typed into the terminal as a path.
    if (!data || /^tab-\d+$/.test(data)) return;
    e.preventDefault();
    const typed = data.includes(" ") ? `"${data.replace(/"/g, '\\"')}"` : data;
    const writer =
      transport === "ssh" ? ssh.write : transport === "pty" ? pty.write : dataLink("serial").write;
    void writer(sessionId, textToBase64(typed + " ")).catch(() => undefined);
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={hostRef}
        className="h-full w-full bg-transparent"
        onContextMenu={onTermContextMenu}
        onDragOver={(e) => {
          if (transport !== "serial" && transport !== "ble" && e.dataTransfer.types.includes("text/plain")) {
            e.preventDefault();
          }
        }}
        onDrop={handleFileDrop}
      />
      <SelectionMenu text={selText} />
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/10 ring-2 ring-inset ring-accent/60">
          <span className="rounded-md bg-surface px-3 py-1 text-[12px] text-fg shadow">
            {t("term.dropToInsert")}
          </span>
        </div>
      )}
    </div>
  );
}
