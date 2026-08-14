import { create } from "zustand";

import { tFrom } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { streamChat } from "./client";
import type { AIChatMessage, AIChatSession } from "@/lib/types";

/**
 * Chat state for the AI assistant.
 *
 * Sessions come in two flavours:
 *  - **chat sessions** (default): user-visible, persisted to localStorage,
 *    listed in the history drawer.
 *  - **transient sessions** (`transient: true`): machine-driven flows (inline
 *    agent runs, auto-diagnose). Kept in memory + storage so a message can be
 *    looked up, but excluded from the history list and purgeable in bulk.
 *
 * The old implementation shared one global `activeId` between the side panel
 * and the terminal inline composer, so an inline question was appended into
 * whatever panel chat was open (and vice versa), and every agent run leaked a
 * permanent "Agent" session full of raw `TOOL RESULT` text into the history.
 * Inline questions now target a per-composer transient session, and agent runs
 * use their own transient session.
 */

const STORAGE_KEY = "ai-sessions-v1";

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function loadSessions(): AIChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AIChatSession[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return [];
}

function saveSessions(sessions: AIChatSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* ignore quota errors */
  }
}

/** True when the user has filled in enough of Settings → AI to make a request. */
export function hasAiConfig(): boolean {
  const s = useAppStore.getState().settings.ai;
  if (!s.baseUrl.trim() || !s.model.trim()) return false;
  if (s.provider !== "ollama" && !s.apiKey.trim()) return false;
  return true;
}

/** Current provider config (mirrors the Rust `ProviderConfig` shape). */
export function currentProvider() {
  const s = useAppStore.getState().settings.ai;
  return {
    kind: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model: s.model,
    temperature: s.temperature,
  };
}

interface AIState {
  sessions: AIChatSession[];
  activeId: string | null;
  panelOpen: boolean;
  width: number;

  newSession: () => string;
  selectSession: (id: string) => void;
  closeSession: (id: string) => void;
  togglePanel: (open?: boolean) => void;
  setWidth: (w: number) => void;

  /** Whether a message in the given session is currently streaming. */
  isStreaming: (sessionId: string) => boolean;
  /** Stop the in-flight generation of the given session (if any). */
  cancelStream: (sessionId: string) => void;
  /** Stop the in-flight generation of the active chat session. */
  cancelActive: () => void;

  /** Send a user message in the active chat session (creating one if needed). */
  send: (text: string, opts?: SendOptions) => Promise<void>;
  /** Send into a *specific* session without touching the active id (used by the
   *  inline composer and auto-diagnose, which own transient sessions). */
  sendToSession: (sessionId: string, text: string, opts?: SendOptions) => Promise<void>;

  /** Create a chat session (visible in history). */
  createSession: (title?: string) => string;
  /** Create a transient session (hidden from history) for machine-driven flows. */
  createTransientSession: (title?: string) => string;
  /** Remove transient sessions that are idle (not streaming). */
  purgeTransientSessions: () => void;

  /** Append a user message to a *specific* session (used by the agent loop). */
  addUserMessageTo: (sessionId: string, text: string) => string;
  /** Append a streaming assistant placeholder to a *specific* session; returns id. */
  addAssistantMessageTo: (sessionId: string) => string;
  /** Append a streamed delta to a specific message. */
  appendDelta: (sessionId: string, msgId: string, delta: string) => void;
  /** Patch a message's fields (e.g. mark streaming done, set error). */
  updateMessage: (
    sessionId: string,
    msgId: string,
    patch: Partial<AIChatMessage>,
  ) => void;
}

/** Optional per-request overrides for `send`. */
export interface SendOptions {
  /** One-off system instruction applied to this request only (not stored in history). */
  system?: string;
  /** Override the auto-generated session title for the first user message. */
  title?: string;
}

/** In-flight cancel handles per session (never serialized). */
const inflight = new Map<string, () => void>();

export const useAiStore = create<AIState>((set, get) => {
  /** Replace one message inside one session and persist. */
  const patchMessage = (
    sessionId: string,
    msgId: string,
    patch: Partial<AIChatMessage>,
  ) => {
    const sessions = get().sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msgId ? { ...m, ...patch } : m,
            ),
          }
        : s,
    );
    set({ sessions });
    saveSessions(sessions);
  };

  const appendDelta = (sessionId: string, msgId: string, delta: string) => {
    const sessions = get().sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            messages: s.messages.map((m) =>
              m.id === msgId ? { ...m, content: m.content + delta } : m,
            ),
          }
        : s,
    );
    set({ sessions });
  };

  const upsertSession = (session: AIChatSession) => {
    const sessions = [session, ...get().sessions.filter((s) => s.id !== session.id)];
    set({ sessions });
    saveSessions(sessions);
  };

  const createSessionBase = (title: string, transient: boolean): string => {
    const id = uid();
    const session: AIChatSession = {
      id,
      title,
      messages: [],
      createdAt: Date.now(),
      transient,
    };
    upsertSession(session);
    return id;
  };

  const runStream = (
    sessionId: string,
    assistantMsgId: string,
    messages: { role: string; content: string }[],
    context: string | undefined,
    appLang: "zh" | "en",
  ): void => {
    const langDir =
      appLang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.";
    const systemMessages = [{ role: "system", content: langDir }, ...messages];
    const handle = streamChat(
      {
        provider: currentProvider(),
        messages: systemMessages,
        context,
      },
      {
        onDelta: (delta) => {
          appendDelta(sessionId, assistantMsgId, delta);
        },
        onDone: (error) => {
          inflight.delete(sessionId);
          if (error === "cancelled") {
            patchMessage(sessionId, assistantMsgId, {
              streaming: false,
              cancelled: true,
            });
          } else if (error) {
            patchMessage(sessionId, assistantMsgId, {
              streaming: false,
              error: true,
              content: tFrom(appLang, "ai.requestFailed", { err: error }),
            });
          } else {
            patchMessage(sessionId, assistantMsgId, { streaming: false });
          }
        },
      },
    );
    inflight.set(sessionId, handle.cancel);
  };

  return {
    sessions: loadSessions(),
    activeId: null,
    panelOpen: false,
    width: 360,

    newSession: () => {
      const id = uid();
      const session: AIChatSession = {
        id,
        title: tFrom(useAppStore.getState().settings.language, "ai.newChat"),
        messages: [],
        createdAt: Date.now(),
      };
      upsertSession(session);
      set({ activeId: id });
      return id;
    },

    selectSession: (id) => set({ activeId: id }),

    closeSession: (id) => {
      inflight.get(id)?.();
      inflight.delete(id);
      const sessions = get().sessions.filter((s) => s.id !== id);
      const activeId =
        get().activeId === id ? sessions[0]?.id ?? null : get().activeId;
      set({ sessions, activeId });
      saveSessions(sessions);
    },

    togglePanel: (open) =>
      set((s) => ({ panelOpen: open === undefined ? !s.panelOpen : open })),

    setWidth: (w) => set({ width: Math.max(320, Math.min(780, w)) }),

    isStreaming: (sessionId) =>
      get().sessions
        .find((s) => s.id === sessionId)
        ?.messages.some((m) => m.streaming) ?? false,

    cancelStream: (sessionId) => {
      inflight.get(sessionId)?.();
      inflight.delete(sessionId);
    },

    cancelActive: () => {
      const aid = get().activeId;
      if (aid) get().cancelStream(aid);
    },

    createSession: (title) =>
      createSessionBase(
        title ?? tFrom(useAppStore.getState().settings.language, "ai.newChat"),
        false,
      ),

    createTransientSession: (title) =>
      createSessionBase(
        title ?? tFrom(useAppStore.getState().settings.language, "ai.agent"),
        true,
      ),

    purgeTransientSessions: () => {
      const sessions = get().sessions.filter(
        (s) => !(s.transient && !s.messages.some((m) => m.streaming)),
      );
      set({ sessions });
      saveSessions(sessions);
    },

    addUserMessageTo: (sessionId, text) => {
      const msg: AIChatMessage = { id: uid(), role: "user", content: text };
      const sessions = get().sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, msg] } : s,
      );
      set({ sessions });
      saveSessions(sessions);
      return msg.id;
    },

    addAssistantMessageTo: (sessionId) => {
      const msg: AIChatMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      const sessions = get().sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, msg] } : s,
      );
      set({ sessions });
      saveSessions(sessions);
      return msg.id;
    },

    appendDelta: (sessionId, msgId, delta) => appendDelta(sessionId, msgId, delta),

    updateMessage: (sessionId, msgId, patch) =>
      patchMessage(sessionId, msgId, patch),

    send: async (text, opts) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      let activeId = get().activeId;
      if (!activeId) activeId = get().newSession();
      await get().sendToSession(activeId, trimmed, opts);
    },

    sendToSession: async (sessionId, text, opts) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Concurrency guard: never stack a second stream onto a session that is
      // already producing. (The UI also disables the send button, but rapid
      // quick-actions could still race in.)
      if (get().isStreaming(sessionId)) return;

      const userMsg: AIChatMessage = {
        id: uid(),
        role: "user",
        content: trimmed,
      };
      const assistantMsg: AIChatMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        streaming: true,
      };

      const sessions = get().sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              title:
                s.messages.length === 0
                  ? (opts?.title ?? trimmed).slice(0, 48)
                  : s.title,
              messages: [...s.messages, userMsg, assistantMsg],
            }
          : s,
      );
      set({ sessions });
      saveSessions(sessions);

      const active = get().sessions.find((s) => s.id === sessionId);
      if (!active) return;
      const history = active.messages
        .filter((m) => m.role !== "system" && m.id !== assistantMsg.id)
        .map((m) => ({ role: m.role, content: m.content }));

      // One-off system instruction for this request only (kept out of history).
      const appLang = useAppStore.getState().settings.language;
      const system = opts?.system
        ? [{ role: "system", content: opts.system }]
        : [];
      const settings = useAppStore.getState().settings.ai;
      const context = settings.terminalContext
        ? buildContext() ?? undefined
        : undefined;

      runStream(sessionId, assistantMsg.id, [...system, ...history], context, appLang);
    },
  };
});
