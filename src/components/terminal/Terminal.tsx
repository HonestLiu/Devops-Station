import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ITheme } from "@xterm/xterm";

import { ssh, pty, serial } from "@/lib/api";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { base64ToBytes, textToBase64 } from "@/lib/utils";
import type { Attached, SessionClosed, StreamChunk } from "@/lib/types";
import { useSessionStore } from "@/store/useSessionStore";
import { useAppStore } from "@/store/useAppStore";
import { scanForError } from "@/ai/errorScan";
import { useAiSuggestion } from "@/ai/useAiSuggestion";
import { registerTerminal, unregisterTerminal, useTerminalSelection } from "@/ai/terminalBridge";
import { SelectionMenu } from "@/ai/SelectionMenu";

export interface TerminalProps {
  sessionId: string;
  transport: "ssh" | "pty" | "serial";
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
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const closedRef = useRef(false);
  // Recent decoded output for the lightweight proactive-error scan. We keep a
  // small tail so cross-chunk errors are still caught without scanning forever.
  const recentRef = useRef("");
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // Kept in a ref so a changing callback never re-runs the session effect.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  // --- lifecycle ----------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const api: TransportApi =
      transport === "ssh" ? ssh : transport === "pty" ? pty : (serial as unknown as TransportApi);

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
    term.loadAddon(new WebLinksAddon());
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
          useSessionStore.getState().setCwd(sessionId, decodeURIComponent(m[1]));
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
          // Proactive error hint: scan decoded output for high-signal errors and
          // offer a dismissible "let AI fix it?" prompt. Gated by Settings → AI.
          if (useAppStore.getState().settings.ai.errorHints) {
            try {
              const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
              if (text) {
                recentRef.current = (recentRef.current + text).slice(-2000);
                const hit = scanForError(recentRef.current);
                if (hit) {
                  useAiSuggestion.getState().offer({
                    sessionId,
                    label: hit.label,
                    snippet: hit.snippet,
                  });
                }
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

        // Ask the remote shell to report its working directory on every prompt
        // via an OSC 7 escape. We hook bash's PROMPT_COMMAND and zsh's precmd;
        // other shells (fish, plain sh) simply won't emit it and the follow
        // feature stays inert instead of breaking the session.
        if (trackCwd) {
          const setup =
            "__ds_cwd(){ printf '\\033]7;file://%s%s\\033\\\\' \"$HOSTNAME\" \"$PWD\"; }; " +
            "if [ -n \"$BASH_VERSION\" ]; then PROMPT_COMMAND=\"${PROMPT_COMMAND:+${PROMPT_COMMAND}; }__ds_cwd\"; " +
            "elif [ -n \"$ZSH_VERSION\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __ds_cwd; fi\n";
          void api.write(sessionId, textToBase64(setup)).catch(() => undefined);
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

    return () => {
      disposed = true;
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

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full bg-transparent" />
      <SelectionMenu text={selText} />
    </div>
  );
}
