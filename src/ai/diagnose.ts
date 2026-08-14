import { useAiComposer } from "./useAiComposer";
import { useAiStore, hasAiConfig } from "./useAiStore";
import { useAiAgent } from "./useAiAgent";
import type { ErrorHit } from "./errorScan";

/**
 * Automatic terminal-error diagnosis.
 *
 * When the user enables Settings → AI → "Auto-diagnose command errors", the
 * terminal data stream (see components/terminal/Terminal.tsx) calls this on a
 * high-signal error. We hand the failing line + recent context to the inline
 * AI composer (auto-sent), which streams the explanation straight into the
 * bottom panel — no "Let AI fix it?" button to click.
 *
 * Design notes:
 * - **Deduplication lives in the caller** (Terminal.tsx): it fingerprints the
 *   error and enforces a global 60s window, and it gates on the attach backlog
 *   being flushed. That is what stops "the same keyword re-triggering", the
 *   "exit and reconnect re-triggers" case, and error lines lingering in the
 *   2000-char tail. This function deliberately has no cooldown of its own — a
 *   second cooldown here would just re-introduce the (sessionId,label)-keyed
 *   bugs (new session id on reconnect ⇒ old record misses ⇒ re-trigger) with
 *   extra complexity.
 * - Still skipped while the AI *agent* runs, so an agent command that fails
 *   doesn't spawn a competing chat reply or loop with the agent loop.
 * - The diagnosis goes to a dedicated **transient** session that is never made
 *   the active chat session and never appears in the history list — the old
 *   code injected the diagnosis into whatever chat session was open, so a
 *   terminal error would pollute the user's conversation. The inline bar is
 *   pointed at that session via `setDisplaySessionId`.
 * - If the AI is not configured we stay silent: without a provider the inline
 *   bar would sit at "正在诊断…" forever.
 */

const DIAG_SYSTEM =
  "You are a senior DevOps / SRE engineer. The user just hit a terminal " +
  "error. Explain the root cause in 2-3 concise sentences, then give the exact " +
  "command(s) to fix it inside fenced code blocks. Use the shell the error came " +
  "from (bash/zsh/sh on POSIX, PowerShell on Windows) — do not assume bash. Do " +
  "not restate the error verbatim. Respond in the user's language.";

/** One reusable transient session for all auto-diagnoses (kept out of history). */
let diagSessionId: string | null = null;

function diagnoseSession(): string {
  if (!diagSessionId || !useAiStore.getState().sessions.some((s) => s.id === diagSessionId)) {
    diagSessionId = useAiStore.getState().createTransientSession();
  }
  return diagSessionId;
}

/**
 * Fire an automatic AI diagnosis for the detected terminal error. No-ops when
 * the agent is running, the AI is not configured, or a diagnosis is already
 * streaming (so a burst of errors never queues several diagnoses behind one
 * another).
 */
export function maybeAutoDiagnose(sessionId: string, hit: ErrorHit, recent: string): void {
  if (useAiAgent.getState().running) return;
  if (!hasAiConfig()) return;

  const sid = diagnoseSession();
  // Don't queue another generation behind one that is already streaming.
  if (useAiStore.getState().isStreaming(sid)) return;

  const context = recent.length > 1500 ? recent.slice(-1500) : recent;
  const prompt =
    `The terminal reported the following error:\n\n` +
    `[${hit.label}] ${hit.snippet}\n\n` +
    `Recent terminal output (for context):\n${context}\n\n` +
    `Explain what caused this error and give the exact command(s) to fix it.`;

  // Send into the transient diagnose session (never the active chat session),
  // then point the inline bar at it and expand the panel immediately so the
  // user sees a "diagnosing…" state before the model responds.
  void useAiStore.getState().sendToSession(sid, prompt, {
    system: DIAG_SYSTEM,
  });
  useAiComposer.getState().setDisplaySessionId(sid);
  useAiComposer.getState().setRevealAnswer(true);
}
