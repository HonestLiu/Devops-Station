import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ai } from "@/lib/api";
import { tFrom } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import type { AIChatMessage, AIChatSession } from "@/lib/types";

const STORAGE_KEY = "ai-sessions-v1";

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function loadSessions(): AIChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AIChatSession[];
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
  send: (text: string, opts?: SendOptions) => Promise<void>;

  /** Append a user message to the active session (creating one if needed). */
  addUserMessage: (text: string) => string;
  /** Append a streaming assistant placeholder to the active session; returns its id. */
  addAssistantMessage: () => string;
  /**
   * Create a session for an *inline* agent run WITHOUT making it the active chat
   * session. This keeps the inline "answer" block showing the user's chat replies
   * instead of the agent's raw monologue, and prevents a follow-up task from
   * appearing to vanish behind the stuck agent state.
   */
  ensureAgentSession: () => string;
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
      const sessions = [session, ...get().sessions];
      set({ sessions, activeId: id });
      saveSessions(sessions);
      return id;
    },

    selectSession: (id) => set({ activeId: id }),

    closeSession: (id) => {
      const sessions = get().sessions.filter((s) => s.id !== id);
      const activeId =
        get().activeId === id ? sessions[0]?.id ?? null : get().activeId;
      set({ sessions, activeId });
      saveSessions(sessions);
    },

    togglePanel: (open) =>
      set((s) => ({ panelOpen: open === undefined ? !s.panelOpen : open })),

    setWidth: (w) => set({ width: Math.max(320, Math.min(780, w)) }),

    addUserMessage: (text) => {
      let activeId = get().activeId;
      if (!activeId) activeId = get().newSession();
      const aid = activeId;
      const msg: AIChatMessage = {
        id: uid(),
        role: "user",
        content: text,
      };
      const sessions = get().sessions.map((s) =>
        s.id === aid
          ? { ...s, messages: [...s.messages, msg] }
          : s,
      );
      set({ sessions });
      saveSessions(sessions);
      return msg.id;
    },

    addAssistantMessage: () => {
      let activeId = get().activeId;
      if (!activeId) activeId = get().newSession();
      const aid = activeId;
      const msg: AIChatMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        streaming: true,
      };
      const sessions = get().sessions.map((s) =>
        s.id === aid
          ? { ...s, messages: [...s.messages, msg] }
          : s,
      );
      set({ sessions });
      saveSessions(sessions);
      return msg.id;
    },

    ensureAgentSession: () => {
      const id = uid();
      const session: AIChatSession = {
        id,
        title: tFrom(useAppStore.getState().settings.language, "ai.agent"),
        messages: [],
        createdAt: Date.now(),
      };
      const sessions = [session, ...get().sessions];
      set({ sessions });
      saveSessions(sessions);
      return id;
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
      const aid = activeId;

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
        s.id === aid
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

      const settings = useAppStore.getState().settings.ai;
      const provider = {
        kind: settings.provider,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        temperature: settings.temperature,
      };

      const active = get().sessions.find((s) => s.id === aid);
      if (!active) return;
      const history = active.messages
        .filter((m) => m.role !== "system" && m.id !== assistantMsg.id)
        .map((m) => ({ role: m.role, content: m.content }));

      // One-off system instruction for this request only (kept out of history).
      // The language directive comes first so the model answers in the user's
      // chosen language regardless of the task-specific system prompt.
      const appLang = useAppStore.getState().settings.language;
      const messages = [
        {
          role: "system",
          content: appLang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.",
        },
        ...(opts?.system ? [{ role: "system", content: opts.system }] : []),
        ...history,
      ];

      const context = settings.terminalContext
        ? buildContext() ?? undefined
        : undefined;

      let reqId: string;
      try {
        reqId = await ai.chat({ provider, messages, context });
      } catch (e) {
        patchMessage(aid, assistantMsg.id, {
          streaming: false,
          error: true,
          content: tFrom(useAppStore.getState().settings.language, "ai.requestFailed", {
            err: String(e),
          }),
        });
        return;
      }

      const unChunk: UnlistenFn = await listen<{
        id: string;
        delta: string;
      }>(`ai-chunk-${reqId}`, (event) => {
        appendDelta(aid, assistantMsg.id, event.payload.delta);
      });

      const unDone: UnlistenFn = await listen<{
        id: string;
        error: string | null;
      }>(`ai-done-${reqId}`, (event) => {
        unChunk();
        unDone();
        if (event.payload.error) {
          patchMessage(aid, assistantMsg.id, {
            streaming: false,
            error: true,
            content: event.payload.error,
          });
        } else {
          patchMessage(aid, assistantMsg.id, { streaming: false });
        }
      });
    },
  };
});
