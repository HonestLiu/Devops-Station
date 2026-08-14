import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ai, type AIChatRequest } from "@/lib/api";

/**
 * Reliable streaming chat client — the single source of truth for every AI call
 * (chat panel, inline composer, agent loop, auto-diagnose).
 *
 * Fixes the structural problems of the old ad-hoc `send` / `complete` flow:
 *
 * 1. **Race between invoke and listen (replies stuck "streaming" forever).**
 *    The old code invoked `ai_chat` first and registered the `ai-chunk-*` /
 *    `ai-done-*` listeners after. Tauri events are push-based: with a fast
 *    provider (Ollama locally, or a request that fails in milliseconds) the
 *    `ai-done` event could be emitted before the listener existed, so the reply
 *    stayed in the streaming state and the UI spun forever. This client
 *    generates the request id itself, registers the *exact* per-id listeners
 *    first, and only then starts the request.
 *
 * 2. **No cancellation.** `cancel()` aborts the backend task via `ai_cancel`
 *    and settles local state, so the UI can flip the message out of streaming
 *    immediately.
 *
 * 3. **Listener leaks.** Every listener is tracked and released exactly once on
 *    every exit path (done event, invoke error, cancel, watchdog timeout).
 *
 * A watchdog timer force-settles the call if the backend never emits `ai-done`
 * (e.g. the process wedged), so the UI can never show an infinite spinner.
 */

function genId(): string {
  return (
    (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export interface StreamHandlers {
  /** Fired for every delta received from the provider. */
  onDelta: (delta: string) => void;
  /**
   * Fired exactly once when the request settles.
   * `error` is `null` on success, `"cancelled"` when the user stopped the
   * generation, or the provider/transport error message.
   */
  onDone: (error: string | null) => void;
}

/** Upper bound for one completion; long agent turns may take a while. */
const WATCHDOG_MS = 300_000;

/**
 * Start a streaming chat completion. Deltas flow through `handlers.onDelta`;
 * the call settles via `handlers.onDone` exactly once.
 *
 * @returns a handle whose `cancel()` stops the generation (idempotent, safe to
 *          call before the backend even accepted the request).
 */
export function streamChat(
  req: Omit<AIChatRequest, "id">,
  handlers: StreamHandlers,
): { cancel: () => void } {
  const id = genId();
  let unChunk: UnlistenFn | null = null;
  let unDone: UnlistenFn | null = null;
  let settled = false;
  let cancelled = false;

  const release = () => {
    unChunk?.();
    unChunk = null;
    unDone?.();
    unDone = null;
  };

  const settle = (error: string | null) => {
    if (settled) return;
    settled = true;
    release();
    handlers.onDone(error);
  };

  const watchdog = window.setTimeout(
    () => settle("Request timed out"),
    WATCHDOG_MS,
  );

  void (async () => {
    try {
      // 1. Register the exact per-id listeners FIRST.
      unChunk = await listen<{ id: string; delta: string }>(
        `ai-chunk-${id}`,
        (e) => {
          if (!cancelled) handlers.onDelta(e.payload.delta);
        },
      );
      unDone = await listen<{ id: string; error: string | null }>(
        `ai-done-${id}`,
        (e) => settle(e.payload.error),
      );
    } catch (e) {
      window.clearTimeout(watchdog);
      settle(String(e));
      return;
    }

    // 2. THEN start the request with the pre-generated id.
    try {
      await ai.chat({ ...req, id });
    } catch (e) {
      window.clearTimeout(watchdog);
      settle(String(e));
    }
  })();

  return {
    cancel: () => {
      if (settled || cancelled) return;
      cancelled = true;
      window.clearTimeout(watchdog);
      void ai.cancel(id).catch(() => undefined);
      settle("cancelled");
    },
  };
}

/**
 * Run a completion and collect the full text. Convenience for callers that only
 * need the final string (e.g. a one-shot request that does not render inline).
 */
export function completeText(
  req: Omit<AIChatRequest, "id">,
): Promise<{ text: string; error: string | null }> {
  return new Promise((resolve) => {
    let text = "";
    streamChat(req, {
      onDelta: (d) => {
        text += d;
      },
      onDone: (error) => resolve({ text, error }),
    });
  });
}
