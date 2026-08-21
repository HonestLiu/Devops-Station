import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import type { ITheme } from "@xterm/xterm";
import { KeywordHighlighter } from "./keywordHighlight";
import { ClipboardPaste, Command, Copy, Eraser, RotateCw, Sparkles, TextSelect } from "lucide-react";

import { ssh, pty, localFs, notify } from "@/lib/api";
import { dataLink } from "@/lib/dataLink";
import { useT } from "@/i18n";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { base64ToBytes, textToBase64 } from "@/lib/utils";
import type { Attached, SessionClosed, StreamChunk } from "@/lib/types";
import { useSessionStore } from "@/store/useSessionStore";
import { useAppStore } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import { isBenignContext, isWaitingForInput, scanForError, errorFingerprint } from "@/ai/errorScan";
import { maybeAutoDiagnose } from "@/ai/diagnose";
import { useAiSuggestion } from "@/ai/useAiSuggestion";
import { useAiComposer } from "@/ai/useAiComposer";
import { EXPLAIN_SYSTEM, FIX_SYSTEM, GENERATE_SYSTEM, writeToTerminal } from "@/ai/terminalAi";
import { SNIPPET_GROUPS } from "@/ai/TerminalInlineAsk";
import { registerTerminal, unregisterTerminal, useTerminalSelection } from "@/ai/terminalBridge";
import { SelectionMenu } from "@/ai/SelectionMenu";

// ---------------------------------------------------------------------------
// Backslash-continuation merging for pasted multi-line commands.
//
// When a user pastes a multi-line command that uses `\` as the line-continuation
// character (e.g. a `docker run` copied from Docker Hub), the pasted text
// contains literal `\` followed by a newline.  In bash/zsh this works because the
// shell treats `\`+newline as a continuation.  In PowerShell and cmd.exe, `\` is
// just a character — each line becomes an independent (and broken) command.
//
// The fix: merge continuation lines into a single line before feeding the text
// to xterm.js.  This is harmless in bash/zsh (a single-line command is
// equivalent) and makes PowerShell / cmd work correctly.
// ---------------------------------------------------------------------------
function mergeContinuationLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const merged: string[] = [];
  let buf = "";
  for (const line of lines) {
    // For continuation lines, strip leading whitespace and join with a space.
    const trimmed = buf === "" ? line : line.replace(/^\s+/, "");
    buf += trimmed;
    if (buf.endsWith("\\")) {
      buf = buf.slice(0, -1); // drop trailing backslash, keep accumulating
    } else {
      merged.push(buf);
      buf = "";
    }
  }
  if (buf) merged.push(buf);
  return merged.join("\n");
}

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
// Primary mechanism: **progressive / delta scanning**. On every data chunk we
// scan ONLY the freshly-arrived text (plus a small boundary overlap so an error
// split across a chunk boundary is not missed). Already-scanned content is never
// re-examined, so an error line that lingers in the scrollback — or a keyword
// that stays on screen while other commands run — can never re-trigger the
// diagnosis. This is what the old "re-scan the whole 2000-char tail every chunk"
// approach got wrong: the same line was re-detected dozens of times.
//
// Secondary safety net: a global error *fingerprint* window (see
// shouldHandleError). It only matters for a *genuinely recurring* error — e.g.
// the same failure printed again 70s later — and stops a burst from a single
// glitch. The window is global (not per session) so "exit and reconnect" within
// the window produces a new session id but the same error and must NOT
// re-trigger.
//
// A third hard gate — `flushed` — prevents scanning the attach backlog (shell
// banner, tail of a previous session, agent startup text) on mount/reconnect.
//
// Character sizes:
//   RECENT_TAIL = 2000  → rolling buffer feeding the waiting-prompt badge.
//   SCAN_OVERLAP = 320  → boundary overlap kept from the PREVIOUS buffer so a
//                         line straddling a chunk boundary is still caught.
/** Bytes of pre-chunk buffer kept as overlap for cross-chunk error lines. */
const SCAN_OVERLAP = 320;

/**
 * A TUI (opencode, …) that exits without cleaning up can leave the terminal's
 * keyboard/mouse protocol enabled: kitty keyboard (ESC[>1u), modifyOtherKeys
 * (ESC[>4m), bracketed paste (ESC[?2004h), focus reporting, mouse tracking.
 * Typed keys then arrive as CSI sequences the shell can't parse — the classic
 * "can't type after quitting a TUI" / endless-garbage symptom.
 *
 * `resetTuiModes` both checks xterm's private-mode state (`term.modes`) and
 * forces every one of those modes off, so it works even when xterm.js never
 * parsed the TUI's enable sequences in the first place.
 */
const TUI_RESET_SEQ =
  "\x1b[<0u" + // kitty keyboard protocol: pop everything (0 = pop all)
  "\x1b[>4;0m" + // modifyOtherKeys: off
  "\x1b[?2004l" + // bracketed paste: off
  "\x1b[?1l" + // application cursor keys: off
  "\x1b[?1004l" + // focus reporting: off
  "\x1b[?1000l" + "\x1b[?1002l" + "\x1b[?1003l" + // mouse tracking: off
  "\x1b[?1006l"; // SGR mouse: off

function resetTuiModes(term: XTerm) {
  const m = term.modes;
  // Force the xterm.js private modes off (checking first is a no-op guard,
  // writing the sequences is what actually resets the state).
  if (m.applicationCursorKeysMode) term.write("\x1b[?1l");
  if (m.bracketedPasteMode) term.write("\x1b[?2004l");
  if (m.sendFocusMode) term.write("\x1b[?1004l");
  if (m.mouseTrackingMode !== "none") {
    term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
  }
  // Keyboard protocols that xterm may not track internally — write them
  // anyway; they are no-ops when the mode was never enabled.
  term.write("\x1b[<0u\x1b[>4;0m");
}
/** Any one error fingerprint may recur at most once per this window, app-wide. */
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
  /** Custom cursor color (hex); empty = use the theme's own cursor color. */
  cursorColor?: string;
  /** Cursor shape while the terminal is unfocused ("outline" = hollow block). */
  cursorInactiveStyle?: "block" | "outline" | "bar";
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
    cursorColor,
    cursorInactiveStyle,
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

  // Custom cursor color overrides the theme default (empty = theme's own).
  // Memoized so the live-options effect doesn't re-run on every render.
  const resolvedTheme: ITheme = useMemo(
    () => (cursorColor ? { ...theme, cursor: cursorColor } : theme),
    [theme, cursorColor],
  );

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const closedRef = useRef(false);
  // Latest session id, readable from mount-once effects (ResizeObserver,
  // highlighter) without re-running them on every session hot-swap.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  // How many sessions this terminal surface has attached. 0 = first attach
  // (fresh xterm), >0 = hot-swap after a reconnect (drop alt buffer + clear).
  const attachCountRef = useRef(0);
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

  // Transport API is derived from the transport kind; shared by the mount-once
  // surface effect (resize) and the per-session attach effect.
  const api = useMemo<TransportApi>(
    () =>
      transport === "ssh"
        ? ssh
        : transport === "pty"
          ? pty
          : (dataLink(transport === "ble" ? "ble" : "serial") as unknown as TransportApi),
    [transport],
  );

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
            if (t) term.paste(t.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
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
      {
        id: "reset",
        label: t("term.reset"),
        icon: <RotateCw size={14} />,
        onClick: () => {
          // Manual escape hatch for a terminal left in a weird mode by a TUI
          // that exited uncleanly. term.reset() wipes every xterm.js mode;
          // the reset sequences also reach the remote shell (restores its
          // stty/readline state). Scrollback is cleared too — this is the
          // nuclear option, so the label says so.
          term.reset();
          term.clear();
          term.focus();
          void api.write(sessionId, textToBase64(TUI_RESET_SEQ + "\x1b[?1049l\x1b[H\x1b[2J")).catch(() => undefined);
        },
      },
    ];

    // When the user has box-selected text, surface the same AI actions the
    // floating selection icon offers — folded into a single "AI" submenu (like
    // the Snippets flyout) so the right-click menu stays short.
    if (sel) {
      items.push(
        { id: "sep-ai", separator: true, label: "" },
        {
          id: "ai",
          label: t("term.aiMenu"),
          icon: <Sparkles size={14} />,
          submenu: [
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
            {
              id: "ai-ask",
              label: t("term.aiAsk"),
              icon: <Sparkles size={14} />,
              // Open the floating selection menu's free-form "ask" input with the
              // current selection as context, so the user can type their own
              // question. (Passing `sel` guarantees context even if the store's
              // live selection hasn't been updated yet.)
              onClick: () => useAiComposer.getState().openAsk(sel),
            },
          ],
        },
      );
    }

    showCtx(e.clientX, e.clientY, items);
  };

  // Drag-and-drop a local file onto the terminal to type its path at the prompt.
  const [dragActive, setDragActive] = useState(false);

  // --- lifecycle ----------------------------------------------------------
  // (A) The xterm surface is created ONCE on mount and kept alive across
  // session hot-swaps. A reconnect after a ConPTY break (a child TUI like
  // OpenCode exited and orphaned the shell) only re-attaches a new session in
  // (B) below — the terminal is NOT torn down and rebuilt, so the screen and
  // scrollback survive ("重新加载终端" no more).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink,
      cursorStyle,
      scrollback,
      theme: resolvedTheme,
      cursorInactiveStyle,
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

    // --- paste: append without auto-submitting ---------------------------------
    // A copied line almost always carries a trailing newline. If we let xterm
    // forward that newline straight to the PTY it is read as Enter, which
    // submits the command already on the line *before* the pasted text is
    // appended — i.e. `git remote add gitlab` runs on its own, then the URL is
    // run as a separate (broken) command. We intercept the DOM paste in the
    // capture phase (so xterm's own bubble-phase paste listener never fires —
    // otherwise we'd get a double paste), strip one leading and one trailing
    // newline (the copy artifacts) and re-feed the cleaned text through xterm
    // so it lands at the cursor and waits for a deliberate Enter. Internal
    // newlines are kept so multi-line pastes still work line-by-line.
    //
    // Backslash continuations (e.g. `docker run -d \<NL>  --name foo`) are
    // merged into a single line before pasting.  Without this, each line is
    // sent to the shell as an independent command — harmless in bash/zsh (where
    // `\`+newline is a continuation) but fatal in PowerShell / cmd where `\` is
    // a literal character.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text == null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const cleaned = text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      term.paste(mergeContinuationLines(cleaned));
    };
    term.textarea?.addEventListener("paste", onPaste, true);

    // Inline images (SIXEL / iTerm2 imgcat) — toggleable in Settings. The addon
    // needs `allowProposedApi` (already set above) and is a no-op until the
    // remote emits a recognized image sequence.
    if (useAppStore.getState().settings.inlineImages) {
      try {
        term.loadAddon(new ImageAddon());
      } catch {
        /* image addon is best-effort */
      }
    }

    // Keyword highlighting: global rules + this host's per-host rules. Re-applied
    // live whenever the settings change.
    const highlighter = new KeywordHighlighter(term);
    const applyHighlightRules = () => {
      const s = useAppStore.getState().settings.keywordHighlight;
      const hostId = useTabsStore
        .getState()
        .tabs.find(
          (tt) =>
            tt.sessionId === sessionRef.current ||
            !!tt.panes?.some((p) => p.sessionId === sessionRef.current),
        )?.hostId;
      const host = hostId ? useHostsStore.getState().hosts.find((h) => h.id === hostId) : undefined;
      const hostEnabled = host?.keywordEnabled;
      const enabled = hostEnabled ?? s.enabled;
      const rules = host?.keywordRules?.length
        ? [...s.rules, ...host.keywordRules]
        : s.rules;
      highlighter.setRules(enabled, rules);
    };
    applyHighlightRules();
    const unsubSettings = useAppStore.subscribe((state, prev) => {
      if (state.settings.keywordHighlight !== prev.settings.keywordHighlight) {
        applyHighlightRules();
      }
    });
    const unsubHosts = useHostsStore.subscribe(() => applyHighlightRules());

    termRef.current = term;
    fitRef.current = fit;

    // Resize observer lives on the surface (A) so it survives hot-swaps; it
    // reads the latest session id from the ref instead of closing over one.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const dims = term.rows && term.cols ? { cols: term.cols, rows: term.rows } : null;
        const sid = sessionRef.current;
        if (dims && sid && (transport === "ssh" || transport === "pty")) {
          void api.resize(sid, dims.cols, dims.rows).catch(() => undefined);
        }
      } catch {
        /* fit can throw if the element isn't measurable yet */
      }
    });
    ro.observe(host);

    return () => {
      term.textarea?.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      unsubSettings?.();
      unsubHosts?.();
      highlighter?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (B) Session attach — re-runs whenever the session id changes, which is how
  // a reconnect hot-swaps the terminal to the freshly spawned shell without
  // rebuilding the xterm instance.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !sessionId) return;

    // Hot-swap (not the first attach): drop back to the main buffer and clear
    // the visible screen (scrollback survives) so the new shell's banner
    // starts clean instead of painting over the dead TUI's alternate-screen
    // residue.
    if (attachCountRef.current > 0) {
      term.write("\x1b[?1049l\x1b[H\x1b[2J");
    }
    attachCountRef.current += 1;
    closedRef.current = false;
    recentRef.current = "";
    waitingRef.current = false;

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
        // A shell prompt means whatever TUI was running (opencode, …) has
        // exited. TUIs often leave keyboard/mouse protocol modes enabled
        // (kitty keyboard, modifyOtherKeys, bracketed paste, focus reporting,
        // mouse tracking); typed keys then arrive as CSI sequences the shell
        // can't parse — the "can't type / endless garbage after quitting a
        // TUI" symptom. Reset those modes directly on the xterm instance.
        resetTuiModes(term);
        return true;
      });
    }

    // Expose the xterm instance so other surfaces (AI "explain selection",
    // command palette) can read the current selection.
    registerTerminal(sessionId, term);
    const onSel = term.onSelectionChange(() => {
      useTerminalSelection.getState().setText(term.getSelection(), sessionId);
    });

    const onData = term.onData((data) => {
      if (!interactiveRef.current || closedRef.current) return;
      // Bracketed-paste markers (ESC[200~ / ESC[201~) must never reach the
      // backend. xterm.js wraps every paste with them once the shell asked for
      // CSI ? 2004 h — but when the paste lands in a child program that never
      // negotiated bracketed paste (a TUI running inside the shell, or a
      // remote shell that doesn't support it), the markers leak into the
      // command line as literal garbage (`^[[200~curl …` → zsh "bad pattern",
      // `bash\x1b[201~` → "command not found: bash~"). Strip them so pastes
      // always arrive as clean text.
      const cleaned = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
      void api.write(sessionId, textToBase64(cleaned));
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
          // Decode once and snapshot `prevTail` (the rolling buffer BEFORE this
          // chunk is appended) so the error scan below can examine only the new
          // delta instead of re-scanning the whole tail — that is what stops
          // already-seen content from re-triggering.
          let text = "";
          try {
            text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          } catch {
            /* decode/scan must never break the terminal stream */
          }
          let prevTail = recentRef.current;
          if (text) {
            prevTail = recentRef.current; // snapshot BEFORE the append below
            recentRef.current = (prevTail + text).slice(-2000);
          }
          // (A) Waiting-for-input detection — ALWAYS on (not gated by the AI
          // error-hint setting): it drives the tab "waiting" badge, the bell
          // panel and the Ctrl+Shift+Enter quick-approval shortcut, all of
          // which must work even when the user disabled AI error hints.
          if (text) {
            const waiting = isWaitingForInput(recentRef.current);
            if (waiting !== waitingRef.current) {
              waitingRef.current = waiting;
              useSessionStore.getState().setWaiting(sessionId, waiting);
            }
          }
          // (B) Proactive error detection: scan decoded output for high-signal
          // errors. Two modes, both gated by Settings → AI:
          //   • errorHints  → show a dismissible "let AI fix it?" prompt
          //   • autoDiagnose → automatically ask the AI and stream the cause to
          //     the bottom panel (no manual click). autoDiagnose wins when both
          //     are on, so the operator never gets the click prompt *and* an
          //     auto-run for the same error.
          //
          // Hard gates that prevent the "keyword → repeated triggers" reports:
          //   1. Only scan AFTER the attach backlog has been flushed (see above).
          //   2. **Progressive delta scan** — we inspect only the freshly-arrived
          //      text plus a SCAN_OVERLAP boundary from the previous buffer, never
          //      the whole 2000-char tail. Each byte is therefore scanned exactly
          //      once; an error line that lingers in the scrollback while other
          //      commands run can never re-trigger, and the attach backlog is
          //      almost entirely excluded (only its last ~320 chars overlap the
          //      first live chunk).
          //   3. A global error-fingerprint window (shouldHandleError) is a
          //      secondary safety net for a *genuinely recurring* error so a
          //      single glitch can't queue several diagnoses.
          const aiSettings = useAppStore.getState().settings.ai;
          if (
            flushed &&
            text &&
            (aiSettings.errorHints || aiSettings.autoDiagnose)
          ) {
            try {
              // Only the new slice: boundary overlap from the previous buffer +
              // this chunk. scanForError(…, 0) scans the whole slice (it is
              // already bounded to one chunk) so a mid-slice error isn't cut off.
              const overlap =
                prevTail.length > SCAN_OVERLAP ? prevTail.slice(-SCAN_OVERLAP) : prevTail;
              const hit = scanForError(overlap + text, 0);
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
      onData.dispose();
      onSel.dispose();
      oscDisposable?.dispose();
      for (const stop of unlisteners) stop();
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
    term.options.theme = resolvedTheme;
    term.options.cursorInactiveStyle = cursorInactiveStyle;
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
  }, [resolvedTheme, cursorInactiveStyle, fontFamily, fontSize, lineHeight, cursorBlink, cursorStyle, scrollback]);

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
