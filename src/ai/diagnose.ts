import { useAiComposer } from "./useAiComposer";
import { useAiStore } from "./useAiStore";
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
 * - Skipped while the AI *agent* runs, so an agent command that fails doesn't
 *   spawn a competing chat reply or loop with the agent loop.
 * - Cooldown per (session, error-label) so a long erroring stream only triggers
 *   one diagnosis instead of one per chunk.
 */

const lastDiag = new Map<string, number>();
const COOLDOWN_MS = 45_000;

const DIAG_SYSTEM =
  "You are a senior DevOps / SRE engineer. The user just hit a terminal " +
  "error. Explain the root cause in 2-3 concise sentences, then give the exact " +
  "command(s) to fix it inside fenced code blocks. Use the shell the error came " +
  "from (bash/zsh/sh on POSIX, PowerShell on Windows) — do not assume bash. Do " +
  "not restate the error verbatim. Respond in the user's language.";

/**
 * Fire an automatic AI diagnosis for the detected terminal error. No-ops when
 * the agent is running or the same error was diagnosed recently.
 */
export function maybeAutoDiagnose(sessionId: string, hit: ErrorHit, recent: string): void {
  if (useAiAgent.getState().running) return;

  const now = Date.now();
  const key = `${sessionId}|${hit.label}`;
  const prev = lastDiag.get(key) ?? 0;
  if (now - prev < COOLDOWN_MS) return;
  lastDiag.set(key, now);

  const context = recent.length > 1500 ? recent.slice(-1500) : recent;
  const prompt =
    `The terminal reported the following error:\n\n` +
    `[${hit.label}] ${hit.snippet}\n\n` +
    `Recent terminal output (for context):\n${context}\n\n` +
    `Explain what caused this error and give the exact command(s) to fix it.`;

  // Send directly rather than through the composer's async prefill chain: a busy
  // terminal emits many chunks and the prefill → useEffect → submit hop is easy
  // to drop. We also flip `revealAnswer` so the bottom panel expands and shows an
  // immediate "diagnosing…" state even before the model responds.
  useAiStore.getState().send(prompt, { system: DIAG_SYSTEM });
  useAiComposer.getState().setRevealAnswer(true);
}
