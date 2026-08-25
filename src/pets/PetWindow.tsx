import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { loadPetManifest, resolvePet, type PetDef } from "./petManifest";
import { usePetEngine, type PetEngineHandle } from "./usePetEngine";
import { PET_LAYOUT } from "./petTypes";
import { PetSprite } from "./PetSprite";
import { REACTION_TO_STATE, type OpenPetsReaction, type SpriteState } from "./petTypes";
import { useT } from "@/i18n";
import { streamChat } from "@/ai/client";
import { currentProvider, hasAiConfig } from "@/ai/useAiStore";
import { useAppStore } from "@/store/useAppStore";
import "./pets.css";

const PET_HEADROOM = 120;
/** Horizontal gap (logical px) between the pet and the right-side panel. */
const GAP = 8;
/** Width (logical px) of the right-side context menu panel. */
const MENU_W = 168;
/** Width (logical px) of the right-side chat dialog panel. */
const CHAT_W = 320;
/** Width (logical px) of the right-side approval-reminder panel. */
const APPROVAL_W = 260;

interface PetSetPayload { id: string; }
interface PetScalePayload { scale: number; }
interface PetReactPayload { reaction: OpenPetsReaction; }
interface PetSayPayload { text: string; }

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * Root component rendered inside the dedicated transparent "pet" Tauri window.
 * Receives all commands from the main window via Tauri events. Right-clicking
 * the pet opens a chat dialog that talks to the embedded AI directly from this
 * window (the conversation floats above everything thanks to always-on-top).
 */
export function PetWindow() {
  const t = useT();
  const [pets, setPets] = useState<PetDef[]>([]);
  const [petId, setPetId] = useState<string>("professor-hoot");
  const [scale, setScale] = useState<number>(1);
  const [stayPut, setStayPut] = useState<boolean>(false);
  const [state, setState] = useState<SpriteState>(REACTION_TO_STATE.idle);
  const [bubble, setBubble] = useState<string | null>(null);

  // Approval reminder dialog (AI waiting for the user's decision). Carries the
  // local terminal session id so the Approve/Reject buttons can act on it.
  const [approval, setApproval] = useState<{ text: string; sessionId?: string } | null>(null);
  const [approvalOpen, setApprovalOpen] = useState<boolean>(false);

  // Right-click menu (currently hosts "AI 对话"; more items to come).
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  // Chat dialog state (opened via the "AI 对话" menu item).
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [streaming, setStreaming] = useState<boolean>(false);
  const cancelRef = useRef<null | (() => void)>(null);
  const msgRef = useRef<HTMLDivElement>(null);

  const engineRef = useRef<PetEngineHandle | null>(null);

  useEffect(() => {
    void loadPetManifest().then((m) => {
      setPets(m.pets);
      setPetId((id) => (m.pets.some((p) => p.id === id) ? id : m.pets[0].id));
      // Notify the main window we're mounted so it can push current pet/scale.
      void emit("pet:ready").catch(() => undefined);
    });
    // Make this webview's background transparent (required for the pet overlay).
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  const pet = resolvePet(pets, petId);

  const { engineRef: eng, dragHandlers } = usePetEngine({
    scale,
    pets,
    petId,
    stayPut,
    paused: chatOpen || menuOpen || approvalOpen,
    onState: setState,
    onBubble: setBubble,
  });
  engineRef.current = eng.current;

  // Keep the chat scrolled to the latest message.
  useEffect(() => {
    if (msgRef.current) msgRef.current.scrollTop = msgRef.current.scrollHeight;
  }, [messages]);

  // --- Window resize helpers -----------------------------------------------
  // The window is widened to the RIGHT (top-left stays fixed) so the pet keeps
  // its on-screen position and any open panel (menu / chat / approval) appears
  // beside it. After resizing we clamp the top-left back onto the current
  // monitor so a right-edge pet doesn't get snapped off-screen by the OS (which
  // would make the pet seemingly "disappear").
  const applyWindow = useCallback(
    async (extraW: number) => {
      const win = getCurrentWindow();
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(PET_LAYOUT.frameWidth * scale);
      const ph = Math.round(PET_LAYOUT.frameHeight * scale);
      const w = pw + GAP + extraW;
      const h = ph + PET_HEADROOM;
      await win.setSize(new LogicalSize(w, h)).catch(() => undefined);
      try {
        const m = (await currentMonitor()) ?? (await primaryMonitor());
        if (m) {
          const x0 = m.position.x / dpr;
          const y0 = m.position.y / dpr;
          const mw = m.size.width / dpr;
          const mh = m.size.height / dpr;
          const pos = await win.outerPosition();
          let nx = pos.x / dpr;
          let ny = pos.y / dpr;
          if (nx < x0) nx = x0;
          if (nx + w > x0 + mw) nx = x0 + mw - w;
          if (ny < y0) ny = y0;
          if (ny + h > y0 + mh) ny = y0 + mh - h;
          await win
            .setPosition(new LogicalPosition(Math.round(nx), Math.round(ny)))
            .catch(() => undefined);
        }
      } catch {
        /* ignore — better to be slightly off than to throw */
      }
    },
    [scale],
  );

  // Recompute the window width from whichever panel(s) are currently open.
  // Priority: approval > menu > chat (only one panel is visible at a time).
  const relayout = useCallback(() => {
    const extra = approvalOpen ? APPROVAL_W : menuOpen ? MENU_W : chatOpen ? CHAT_W : 0;
    void applyWindow(extra);
  }, [approvalOpen, menuOpen, chatOpen, applyWindow]);

  // Resize whenever the open panel set or scale changes.
  useEffect(() => {
    void relayout();
  }, [relayout]);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openChat = useCallback(() => setChatOpen(true), []);
  const closeChat = useCallback(() => {
    cancelRef.current?.();
    setChatOpen(false);
    setMessages([]);
    setInput("");
    setStreaming(false);
  }, []);

  const closeApproval = useCallback(() => {
    setApprovalOpen(false);
    setApproval(null);
  }, []);

  const onApprove = useCallback(() => {
    void emit("pet:approval-action", { action: "approve", sessionId: approval?.sessionId });
    closeApproval();
  }, [approval, closeApproval]);

  const onReject = useCallback(() => {
    void emit("pet:approval-action", { action: "reject", sessionId: approval?.sessionId });
    closeApproval();
  }, [approval, closeApproval]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;
    if (!hasAiConfig()) {
      setMessages((m) => [
        ...m,
        { id: uid(), role: "assistant", content: t("pets.chatNoConfig") },
      ]);
      setInput("");
      return;
    }
    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const aiMsg: ChatMessage = { id: uid(), role: "assistant", content: "" };
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, aiMsg]);
    setInput("");
    setStreaming(true);

    const lang = useAppStore.getState().settings.language;
    const dir = lang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.";
    const handle = streamChat(
      {
        provider: currentProvider(),
        messages: [{ role: "system", content: dir }, ...history],
      },
      {
        onDelta: (d) =>
          setMessages((m) =>
            m.map((mm) => (mm.id === aiMsg.id ? { ...mm, content: mm.content + d } : mm)),
          ),
        onDone: () => setStreaming(false),
      },
    );
    cancelRef.current = handle.cancel;
  }, [input, streaming, messages, t]);

  const stop = useCallback(() => {
    cancelRef.current?.();
    setStreaming(false);
  }, []);

  // Close the chat dialog or the right-click menu on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (chatOpen) void closeChat();
      else if (menuOpen) void closeMenu();
      else if (approvalOpen) void closeApproval();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen, menuOpen, approvalOpen, closeChat, closeMenu, closeApproval]);

  // Listen for commands from the main window.
  useEffect(() => {
    let unsubs: (() => void)[] = [];
    const reg = async () => {
      unsubs.push(
        await listen<PetSetPayload>("pet:set-pet", (e) => setPetId(e.payload.id)),
      );
      unsubs.push(
        await listen<{ stay: boolean }>("pet:stay", (e) => setStayPut(e.payload.stay)),
      );
      // Reveal / hide this overlay window on itself (permissions are scoped to
      // the "pet" window, so the main window only sends these as events).
      unsubs.push(
        await listen("pet:open", () => {
          void getCurrentWindow().show().catch(() => undefined);
          void getCurrentWindow().setFocus().catch(() => undefined);
        }),
      );
      unsubs.push(
        await listen("pet:close", () => {
          void getCurrentWindow().hide().catch(() => undefined);
        }),
      );
      unsubs.push(
        await listen<PetScalePayload>("pet:scale", (e) => {
          setScale(e.payload.scale);
          // Resize the window to fit the new sprite + reserved bubble headroom,
          // then re-center on the next frame once React has updated the scale.
          void getCurrentWindow()
            .setSize(
              new LogicalSize(
                Math.round(PET_LAYOUT.frameWidth * e.payload.scale),
                Math.round(PET_LAYOUT.frameHeight * e.payload.scale + PET_HEADROOM),
              ),
            )
            .catch(() => undefined);
          requestAnimationFrame(() => engineRef.current?.reset());
        }),
      );
      unsubs.push(
        await listen<PetReactPayload>("pet:react", (e) => engineRef.current?.react(e.payload.reaction)),
      );
      unsubs.push(
        await listen<PetSayPayload>("pet:say", (e) => engineRef.current?.say(e.payload.text)),
      );
      unsubs.push(
        await listen("pet:reset", () => engineRef.current?.reset()),
      );
      // Approval reminder dialog: open the right-side panel with the pending
      // request's text and the local session id to act on.
      unsubs.push(
        await listen<{ text: string; sessionId?: string }>("pet:alert", (e) => {
          setApproval({ text: e.payload.text, sessionId: e.payload.sessionId });
          setApprovalOpen(true);
        }),
      );
      unsubs.push(
        await listen("pet:alert-clear", () => {
          setApproval(null);
          setApprovalOpen(false);
        }),
      );
    };
    void reg();
    return () => {
      unsubs.forEach((u) => u());
    };
  }, []);

  // Right-click menu — extensible list; for now it just holds "AI 对话".
  const menuItems = [
    { id: "ai-chat", label: t("pets.chatMenuItem"), onClick: () => void openChat() },
  ];

  const onPetContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (chatOpen) return;
    if (approvalOpen) {
      void closeApproval();
      return;
    }
    if (menuOpen) void closeMenu();
    else void openMenu();
  };

  return (
    <div className="pet-stage">
      {/* Pet always sits on the left; the menu / chat panel render to its right. */}
      {pet && (
        <div
          className="pet-anchor"
          onPointerDown={dragHandlers.current.onPointerDown}
          onPointerMove={dragHandlers.current.onPointerMove}
          onPointerUp={dragHandlers.current.onPointerUp}
          onClick={dragHandlers.current.onClick}
          onContextMenu={onPetContextMenu}
        >
          {bubble && <div className="pet-bubble">{bubble}</div>}
          <PetSprite pet={pet} scale={scale} state={state} />
        </div>
      )}

      {menuOpen && pet && (
        <div className="pet-menu">
          <div className="pet-menu-title">{t("pets.menuTitle")}</div>
          {menuItems.map((it) => (
            <button
              key={it.id}
              className="pet-menu-item"
              onClick={() => {
                void closeMenu();
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {chatOpen && pet && (
        <div className="pet-chat" onContextMenu={(e) => e.preventDefault()}>
          <div className="pet-chat-bar">
            <span>{t("pets.chatTitle")}</span>
          </div>
          <div className="pet-chat-messages" ref={msgRef}>
            {messages.length === 0 && (
              <div className="pet-chat-empty">{t("pets.chatEmpty")}</div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`pet-msg ${m.role}`}>
                <div className="pet-msg-bubble">
                  {m.content || (m.role === "assistant" ? "…" : "")}
                </div>
              </div>
            ))}
          </div>
          <form
            className="pet-chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t("pets.chatPlaceholder")}
              disabled={streaming}
            />
            {streaming ? (
              <button type="button" className="pet-chat-send" onClick={stop}>
                {t("common.stop")}
              </button>
            ) : (
              <button type="submit" className="pet-chat-send" disabled={!input.trim()}>
                {t("pets.chatSend")}
              </button>
            )}
          </form>
          <button
            className="pet-chat-close"
            title={t("common.close")}
            onClick={() => void closeChat()}
          >
            ×
          </button>
        </div>
      )}

      {approvalOpen && approval && pet && (
        <div className="pet-approval" onContextMenu={(e) => e.preventDefault()}>
          <div className="pet-approval-bar">
            <span className="pet-approval-icon" aria-hidden>⚠️</span>
            <span>{t("pets.approvalTitle")}</span>
          </div>
          <div className="pet-approval-body">{approval.text}</div>
          <div className="pet-approval-actions">
            <button className="pet-btn pet-btn-approve" onClick={onApprove}>
              {t("pets.approve")}
            </button>
            <button className="pet-btn pet-btn-reject" onClick={onReject}>
              {t("pets.reject")}
            </button>
          </div>
          <button
            className="pet-approval-close"
            title={t("common.close")}
            onClick={() => void closeApproval()}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
