import { useCallback, useEffect, useState, type ReactNode } from "react";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity,
  Bell,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Keyboard,
  Loader2,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Trash2,
  Type,
  Upload,
  Wrench,
} from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { FontDialog } from "@/components/FontDialog";
import { notify, permHook, profile, type HookStatus } from "@/lib/api";
import { isWindows } from "@/lib/platform";
import { formatShortcut, setShortcutRecording } from "@/lib/shortcut";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { THEME_LIST } from "@/lib/themes";
import { useAppStore, DEFAULT_SETTINGS, type AppSettings, type Language } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { CheckForUpdatesButton } from "@/components/UpdateDialog";
import type {
  AIProviderKind,
  AISettings,
  ApprovalHookTools,
  ApprovalSettings,
  ThemeId,
} from "@/lib/types";

/** Tools with installable permission hooks, shown in Settings → 审批通知. */
const HOOK_TOOLS: { id: keyof ApprovalHookTools; label: string; config: string }[] = [
  { id: "claude", label: "Claude Code", config: "~/.claude/settings.json" },
  { id: "codex", label: "Codex", config: "~/.codex/hooks.json" },
  { id: "opencode", label: "OpenCode", config: "~/.config/opencode/plugins" },
];

// --- Toggle switch ---------------------------------------------------------
// Premium-looking on/off control used for every boolean setting. Local to this
// page so it never interferes with the shared `Checkbox` used elsewhere.
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
        checked ? "bg-accent" : "bg-border hover:bg-subtle/50",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-150",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// --- Setting row -----------------------------------------------------------
// Label + optional description on the left, control on the right. On narrow
// screens it stacks; on wider screens the control is right-aligned. `full`
// lets a control span the entire width (multi-control rows like a path picker).
function Row({
  title,
  desc,
  children,
  htmlFor,
  full,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  htmlFor?: string;
  full?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 py-3.5",
        full ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <div className={cn("min-w-0", !full && "sm:max-w-[58%]")}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="cursor-pointer text-[13px] font-medium text-fg">
            {title}
          </label>
        ) : (
          <div className="text-[13px] font-medium text-fg">{title}</div>
        )}
        {desc && <div className="mt-1 text-[11px] leading-relaxed text-subtle">{desc}</div>}
      </div>
      <div className={cn("shrink-0", full ? "w-full" : "sm:max-w-[42%] sm:flex-1")}>
        {children}
      </div>
    </div>
  );
}

// --- Section card -----------------------------------------------------------
function Section({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-4">
      <div className="mb-1 flex items-center gap-2.5">
        <span className="icon-chip">{icon}</span>
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
      </div>
      <div className="mt-1 divide-y divide-border/60">{children}</div>
    </section>
  );
}

/**
 * Click-to-record shortcut input: while recording, captures the next modifier
 * combination the user presses and reports it as "ctrl+alt+shift+meta+Code".
 * Requires at least one modifier so a bare key can never be bound.
 */
function ShortcutRecorder({
  value,
  onChange,
  recordHint,
  pressHint,
}: {
  value: string;
  onChange: (v: string) => void;
  recordHint: string;
  pressHint: string;
}) {
  const [recording, setRecording] = useState(false);

  // Publish the recording state globally so the app-level shortcut handlers
  // (registered on window in the capture phase, before this listener) stand
  // down — otherwise a combination equal to an existing shortcut is consumed
  // and stopPropagation'd before the recorder ever sees it.
  const stopRecording = () => {
    setShortcutRecording(false);
    setRecording(false);
  };

  useEffect(() => {
    if (!recording) return;
    setShortcutRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        stopRecording();
        return;
      }
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      if (e.metaKey) mods.push("meta");
      onChange([...mods, e.code].join("+"));
      stopRecording();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setShortcutRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, onChange]);

  return (
    <button
      type="button"
      onClick={() => (recording ? stopRecording() : setRecording(true))}
      title={recording ? undefined : recordHint}
      className={cn(
        "no-drag flex h-9 w-60 items-center justify-center rounded-lg border font-mono text-[12px] transition-colors",
        recording
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-bg text-fg hover:bg-hover",
      )}
    >
      {recording ? pressHint : formatShortcut(value)}
    </button>
  );
}

export function Settings() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const updateSetting = useAppStore((s) => s.updateSetting);
  const resetSettings = useAppStore((s) => s.resetSettings);
  const [fontOpen, setFontOpen] = useState(false);

  // Current app version, shown in the Updates section.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => undefined);
  }, []);

  // Keep the Rust-side approval-notification switch in sync with the setting.
  useEffect(() => {
    if (!settingsLoaded) return;
    void notify.setApprovalNotifications(settings.approvalNotifications).catch(() => undefined);
  }, [settingsLoaded, settings.approvalNotifications]);

  // --- Section navigation ----------------------------------------------------
  const SECTION_META: { id: string; icon: ReactNode; titleKey: Parameters<typeof t>[0] }[] = [
    { id: "appearance", icon: <Palette size={15} />, titleKey: "settings.appearance" },
    { id: "terminal", icon: <Terminal size={15} />, titleKey: "settings.terminal" },
    { id: "monitoring", icon: <Activity size={15} />, titleKey: "settings.monitoring" },
    { id: "ai", icon: <Bot size={15} />, titleKey: "settings.aiAssistant" },
    { id: "shell", icon: <Monitor size={15} />, titleKey: "settings.localShell" },
    { id: "jlink", icon: <Cpu size={15} />, titleKey: "settings.jlink" },
    { id: "shortcuts", icon: <Keyboard size={15} />, titleKey: "settings.shortcuts" },
    { id: "notifications", icon: <Bell size={15} />, titleKey: "settings.notifications" },
    { id: "updates", icon: <RefreshCw size={15} />, titleKey: "settings.updates" },
    { id: "data", icon: <Database size={15} />, titleKey: "settings.data" },
  ];
  const [activeSection, setActiveSection] = useState("appearance");
  useEffect(() => {
    const els = SECTION_META.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => !!el,
    );
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSection(e.target.id);
        }
      },
      { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    void updateSetting(k, v);

  const setAi = <K extends keyof AISettings>(k: K, v: AISettings[K]) =>
    void updateSetting("ai", { ...settings.ai, [k]: v });

  const setApproval = <K extends keyof ApprovalSettings>(k: K, v: ApprovalSettings[K]) =>
    void updateSetting("approval", {
      ...(settings.approval ?? DEFAULT_SETTINGS.approval),
      [k]: v,
    });
  const setApprovalTool = (tool: keyof ApprovalHookTools, v: boolean) =>
    void updateSetting("approval", {
      ...(settings.approval ?? DEFAULT_SETTINGS.approval),
      tools: {
        ...(settings.approval?.tools ?? DEFAULT_SETTINGS.approval.tools),
        [tool]: v,
      },
    });

  // --- Approval hooks (per-tool install / status) --------------------------
  const [hookStatus, setHookStatus] = useState<Record<string, HookStatus | null>>({});
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [hookMsg, setHookMsg] = useState<string | null>(null);

  const refreshHooks = useCallback(async () => {
    const next: Record<string, HookStatus | null> = {};
    await Promise.all(
      HOOK_TOOLS.map(async (tool) => {
        try {
          next[tool.id] = await permHook.status(tool.id);
        } catch {
          next[tool.id] = null;
        }
      }),
    );
    setHookStatus(next);
  }, []);
  useEffect(() => {
    void refreshHooks();
  }, [refreshHooks]);

  const toggleHook = async (tool: (typeof HOOK_TOOLS)[number]) => {
    setBusyTool(tool.id);
    setHookMsg(null);
    try {
      const st = hookStatus[tool.id];
      setHookMsg(
        st?.installed
          ? await permHook.uninstall(tool.id)
          : await permHook.install(tool.id, settings.approval.port),
      );
      await refreshHooks();
    } catch (e) {
      setHookMsg(String(e));
    } finally {
      setBusyTool(null);
    }
  };

  const uninstallAllHooks = async () => {
    setBusyTool("all");
    setHookMsg(null);
    try {
      const results = await Promise.all(
        HOOK_TOOLS.map(async (tool) => {
          try {
            if (hookStatus[tool.id]?.installed) {
              return await permHook.uninstall(tool.id);
            }
            return `${tool.label}：${t("settings.hookNotInstalled")}`;
          } catch (e) {
            return `${tool.label}：${String(e)}`;
          }
        }),
      );
      setHookMsg(results.join("\n"));
      await refreshHooks();
    } finally {
      setBusyTool(null);
    }
  };

  // --- Data export / import ------------------------------------------------
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataStatus, setDataStatus] = useState("");

  const doExport = async () => {
    setDataBusy(true);
    setDataStatus("");
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const picked = await save({
        title: t("settings.exportLabel"),
        defaultPath: `devops-station-profile-${stamp}.json`,
        filters: [{ name: "DevOps Station Profile", extensions: ["json"] }],
      });
      if (!picked) return;
      const info = await profile.export(picked, includeSecrets);
      setDataStatus(
        t("settings.exported", {
          hosts: info.hosts,
          cmds: info.quickCommands,
          items: info.settings,
          fonts: info.fonts,
          path: info.path,
        }) + (info.includeSecrets ? t("settings.exportedSecretsNote") : ""),
      );
    } catch (err) {
      setDataStatus(t("settings.exportFailed", { err: String(err) }));
    } finally {
      setDataBusy(false);
    }
  };

  const doImport = async (mode: "merge" | "replace") => {
    setDataBusy(true);
    setDataStatus("");
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "DevOps Station Profile", extensions: ["json"] }],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      if (!file) return;
      if (mode === "replace") {
        const ok = await confirm(t("settings.replaceConfirm"), {
          title: t("settings.replaceTitle"),
          kind: "warning",
        });
        if (!ok) return;
      }
      const info = await profile.import(file, mode);
      // Reflect imported data immediately in every store.
      await Promise.all([
        useAppStore.getState().loadSettings(),
        useHostsStore.getState().load(),
      ]);
      setDataStatus(
        t("settings.importDone", {
          verb: mode === "replace" ? t("settings.importReplaced") : t("settings.importMerged"),
          hosts: info.hosts,
          cmds: info.quickCommands,
          items: info.settings,
          fonts: info.fonts,
        }),
      );
    } catch (err) {
      setDataStatus(t("settings.importFailed", { err: String(err) }));
    } finally {
      setDataBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("settings.title")}</h1>
          <p className="page-subtitle">{t("settings.subtitle")}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void resetSettings()}>
          <RotateCcw size={14} /> {t("settings.reset")}
        </Button>
      </div>

      <div className="flex gap-6">
        {/* Left navigation rail */}
        <nav className="sticky top-0 hidden h-[calc(100vh-120px)] w-44 shrink-0 flex-col lg:flex">
          <ul className="space-y-0.5">
            {SECTION_META.map((s) => {
              const active = activeSection === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() =>
                      document
                        .getElementById(s.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "bg-accent/10 text-accent"
                        : "text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <span className="shrink-0">{s.icon}</span>
                    <span className="truncate">{t(s.titleKey)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-6 pb-6">
          {/* Theme */}
          <Section id="appearance" icon={<Palette size={15} />} title={t("settings.appearance")}>
            <Row title={t("settings.language")} htmlFor="set-language">
              <Select
                id="set-language"
                value={settings.language}
                onChange={(e) => set("language", e.target.value as Language)}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </Select>
            </Row>
            <Row title={t("settings.theme")} full>
              <div className="flex flex-wrap gap-2">
                {THEME_LIST.map((th) => {
                  const active = settings.theme === th.id;
                  return (
                    <button
                      key={th.id}
                      onClick={() => set("theme", th.id as ThemeId)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors",
                        active
                          ? "border-accent bg-accent/10 text-fg"
                          : "border-border bg-bg text-muted hover:bg-hover",
                      )}
                    >
                      <span className="flex overflow-hidden rounded">
                        {th.swatch.map((c, i) => (
                          <span key={i} className="h-3.5 w-3.5" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                      {th.label}
                    </button>
                  );
                })}
              </div>
            </Row>
          </Section>

          {/* Terminal */}
          <Section id="terminal" icon={<Terminal size={15} />} title={t("settings.terminal")}>
            <Row title={t("settings.fontFamily")} desc={t("settings.fontHint")} full>
              <div className="flex flex-col gap-2">
                <Button variant="secondary" size="sm" onClick={() => setFontOpen(true)}>
                  <Type size={14} /> {t("settings.configureFonts")}
                </Button>
                <span
                  className="truncate font-mono text-[11px] text-subtle"
                  title={settings.fontFamily}
                >
                  {settings.fontFamily}
                </span>
              </div>
              <FontDialog open={fontOpen} onClose={() => setFontOpen(false)} />
            </Row>
            <Row title={t("settings.fontSize")} desc={t("settings.fontRecommended")}>
              <Input
                type="number"
                min={8}
                max={32}
                value={settings.fontSize}
                onChange={(e) => set("fontSize", Number(e.target.value) || 13)}
              />
            </Row>
            <Row title={t("settings.lineHeight")}>
              <Input
                type="number"
                step={0.05}
                min={1}
                max={2}
                value={settings.lineHeight}
                onChange={(e) => set("lineHeight", Number(e.target.value) || 1.25)}
              />
            </Row>
            <Row title={t("settings.scrollback")}>
              <Input
                type="number"
                step={1000}
                min={500}
                max={100000}
                value={settings.scrollback}
                onChange={(e) => set("scrollback", Number(e.target.value) || 10000)}
              />
            </Row>
            <Row title={t("settings.cursorStyle")}>
              <Select
                value={settings.cursorStyle}
                onChange={(e) =>
                  set("cursorStyle", e.target.value as AppSettings["cursorStyle"])
                }
              >
                <option value="block">{t("settings.optBlock")}</option>
                <option value="underline">{t("settings.optUnderline")}</option>
                <option value="bar">{t("settings.optBar")}</option>
              </Select>
            </Row>
            <Row title={t("settings.cursorBlink")}>
              <Switch
                checked={settings.cursorBlink}
                onChange={(v) => set("cursorBlink", v)}
                label={t("settings.cursorBlink")}
              />
            </Row>
            <Row title={t("settings.copyOnSelect")}>
              <Switch
                checked={settings.copyOnSelect}
                onChange={(v) => set("copyOnSelect", v)}
                label={t("settings.copyOnSelect")}
              />
            </Row>
            <Row title={t("settings.confirmClose")}>
              <Switch
                checked={settings.confirmOnClose}
                onChange={(v) => set("confirmOnClose", v)}
                label={t("settings.confirmClose")}
              />
            </Row>
          </Section>

          {/* Monitoring */}
          <Section id="monitoring" icon={<Activity size={15} />} title={t("settings.monitoring")}>
            <Row title={t("settings.metricsInterval")}>
              <Select
                value={settings.metricsInterval}
                onChange={(e) => set("metricsInterval", Number(e.target.value))}
              >
                <option value={1000}>{t("settings.opt1s")}</option>
                <option value={2000}>{t("settings.opt2s")}</option>
                <option value={5000}>{t("settings.opt5s")}</option>
              </Select>
            </Row>
          </Section>

          {/* AI Assistant */}
          <Section id="ai" icon={<Bot size={15} />} title={t("settings.aiAssistant")}>
            <Row title={t("settings.provider")}>
              <Select
                value={settings.ai.provider}
                onChange={(e) => setAi("provider", e.target.value as AIProviderKind)}
              >
                <option value="openai">{t("settings.optOpenAI")}</option>
                <option value="ollama">{t("settings.optOllama")}</option>
                <option value="custom">{t("settings.optCustom")}</option>
              </Select>
            </Row>
            <Row title={t("settings.baseUrl")} desc={t("settings.baseUrlHint")}>
              <Input
                value={settings.ai.baseUrl}
                onChange={(e) => setAi("baseUrl", e.target.value)}
                className="font-mono text-[12px]"
              />
            </Row>
            <Row title={t("settings.apiKey")} desc={t("settings.apiKeyHint")}>
              <Input
                type="password"
                value={settings.ai.apiKey}
                onChange={(e) => setAi("apiKey", e.target.value)}
                className="font-mono text-[12px]"
              />
            </Row>
            <Row title={t("settings.model")}>
              <Input
                value={settings.ai.model}
                onChange={(e) => setAi("model", e.target.value)}
                className="font-mono text-[12px]"
              />
            </Row>
            <Row title={t("settings.temperature")}>
              <Input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={settings.ai.temperature}
                onChange={(e) => setAi("temperature", Number(e.target.value) || 0.3)}
              />
            </Row>
            <Row title={t("settings.terminalContext")}>
              <Switch
                checked={settings.ai.terminalContext}
                onChange={(v) => setAi("terminalContext", v)}
                label={t("settings.terminalContext")}
              />
            </Row>
            <Row title={t("settings.errorHints")}>
              <Switch
                checked={settings.ai.errorHints}
                onChange={(v) => setAi("errorHints", v)}
                label={t("settings.errorHints")}
              />
            </Row>
            <Row title={t("settings.autoDiagnose")} desc={t("settings.autoDiagnoseHint")}>
              <Switch
                checked={settings.ai.autoDiagnose}
                onChange={(v) => setAi("autoDiagnose", v)}
                label={t("settings.autoDiagnose")}
              />
            </Row>
            <Row title={t("settings.useKb")}>
              <Switch
                checked={settings.ai.useKnowledgeBase}
                onChange={(v) => setAi("useKnowledgeBase", v)}
                label={t("settings.useKb")}
              />
            </Row>
            <Row title={t("settings.kbPath")} desc={t("settings.kbHint")}>
              <Input
                value={settings.ai.knowledgeBasePath}
                onChange={(e) => setAi("knowledgeBasePath", e.target.value)}
                className="font-mono text-[12px]"
                placeholder={t("settings.kbPathPh")}
              />
            </Row>
          </Section>

          {/* Local Shell */}
          <Section id="shell" icon={<Monitor size={15} />} title={t("settings.localShell")}>
            <Row title={t("settings.defaultShell")} desc={t("settings.shellHint")}>
              <Select
                value={settings.localShell}
                onChange={(e) => set("localShell", e.target.value)}
              >
                <option value="default">{t("settings.optDefaultShell")}</option>
                {isWindows ? (
                  <>
                    <option value="powershell">PowerShell</option>
                    <option value="pwsh">PowerShell (pwsh)</option>
                    <option value="cmd">Command Prompt (cmd)</option>
                    <option value="git-bash">Git Bash</option>
                    <option value="bash">bash (Git Bash / WSL)</option>
                  </>
                ) : (
                  <>
                    <option value="bash">{t("settings.optBash")}</option>
                    <option value="zsh">{t("settings.optZsh")}</option>
                    <option value="fish">{t("settings.optFish")}</option>
                    <option value="sh">{t("settings.optSh")}</option>
                  </>
                )}
              </Select>
            </Row>
          </Section>

          {/* J-Link */}
          <Section id="jlink" icon={<Cpu size={15} />} title={t("settings.jlink")}>
            <Row
              title={t("settings.jlinkPath")}
              desc={t("settings.jlinkHint")}
              full
            >
              <div className="flex items-center gap-2">
                <Input
                  value={settings.jlinkPath}
                  onChange={(e) => set("jlinkPath", e.target.value)}
                  placeholder={isWindows ? t("settings.jlinkPhWin") : t("settings.jlinkPhUnix")}
                  className="font-mono text-[12px]"
                />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const picked = await open({
                      multiple: false,
                      filters: isWindows
                        ? [{ name: "J-Link Executable", extensions: ["exe"] }]
                        : undefined,
                    });
                    if (typeof picked === "string" && picked) {
                      set("jlinkPath", picked);
                    }
                  }}
                  className="h-8 shrink-0 whitespace-nowrap"
                >
                  {t("settings.browse")}
                </Button>
              </div>
            </Row>
          </Section>

          {/* Shortcuts */}
          <Section id="shortcuts" icon={<Keyboard size={15} />} title={t("settings.shortcuts")}>
            <Row
              title={t("settings.approveShortcut")}
              desc={t("settings.approveShortcutHint")}
              full
            >
              <ShortcutRecorder
                value={settings.approveShortcut}
                onChange={(v) => set("approveShortcut", v)}
                recordHint={t("settings.shortcutRecordHint")}
                pressHint={t("settings.shortcutPress")}
              />
            </Row>
          </Section>

          {/* Notifications */}
          <Section id="notifications" icon={<Bell size={15} />} title={t("settings.notifications")}>
            <Row
              title={t("settings.approvalNotifications")}
              desc={t("settings.approvalNotificationsHint")}
            >
              <Switch
                checked={settings.approvalNotifications}
                onChange={(v) => {
                  void updateSetting("approvalNotifications", v);
                  void notify.setApprovalNotifications(v).catch(() => undefined);
                }}
                label={t("settings.approvalNotifications")}
              />
            </Row>

            {/* Approval detection via per-tool permission HOOKS (primary path) */}
            <Row
              title={t("settings.approvalHooks")}
              desc={t("settings.approvalHooksHint")}
            >
              <Switch
                checked={settings.approval.enabled}
                onChange={(v) => setApproval("enabled", v)}
                label={t("settings.approvalHooks")}
              />
            </Row>

            {settings.approval.enabled && (
              <>
                <Row title={t("settings.approvalHookPort")} desc={t("settings.approvalHookPortHint")}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1024}
                      max={65535}
                      value={settings.approval.port}
                      onChange={(e) => setApproval("port", Number(e.target.value) || 47890)}
                      className="w-28"
                    />
                    <span className="text-[11px] text-subtle">
                      127.0.0.1:{settings.approval.port}/approval
                    </span>
                  </div>
                </Row>

                {HOOK_TOOLS.map((tool) => {
                  const st = hookStatus[tool.id];
                  const installed = !!st?.installed;
                  return (
                    <Row key={tool.id} title={tool.label} desc={tool.config}>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={settings.approval.tools?.[tool.id] ?? false}
                          onChange={(v) => setApprovalTool(tool.id, v)}
                          label={`${tool.label} ${t("settings.approvalToolRemind")}`}
                        />
                        <Button
                          size="sm"
                          variant={installed ? "secondary" : "primary"}
                          disabled={busyTool !== null}
                          onClick={() => void toggleHook(tool)}
                          title={
                            installed
                              ? t("settings.hookUninstallTitle")
                              : t("settings.hookInstallTitle")
                          }
                        >
                          {busyTool === tool.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : installed ? (
                            <Wrench size={12} />
                          ) : (
                            <ShieldCheck size={12} />
                          )}
                          {busyTool === tool.id
                            ? t("settings.hookBusy")
                            : installed
                              ? t("settings.hookUninstall")
                              : t("settings.hookInstall")}
                        </Button>
                        <span
                          className={cn(
                            "flex items-center gap-1 text-[11px]",
                            installed ? "text-success" : "text-subtle",
                          )}
                        >
                          {st == null ? (
                            "—"
                          ) : installed ? (
                            <>
                              <CheckCircle2 size={11} /> {t("settings.hookInstalled")}
                            </>
                          ) : st.toolDetected ? (
                            t("settings.hookNotInstalled")
                          ) : (
                            t("settings.hookToolMissing")
                          )}
                        </span>
                      </div>
                    </Row>
                  );
                })}

                {HOOK_TOOLS.some((tool) => hookStatus[tool.id]?.installed) && (
                  <Row
                    title={t("settings.hookUninstallAll")}
                    desc={t("settings.hookUninstallAllHint")}
                  >
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyTool !== null}
                      onClick={() => void uninstallAllHooks()}
                      title={t("settings.hookUninstallAllTitle")}
                    >
                      {busyTool === "all" ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      {busyTool === "all" ? t("settings.hookBusy") : t("settings.hookUninstallAll")}
                    </Button>
                  </Row>
                )}

                {hookMsg && (
                  <Row title={t("settings.hookResult")} full>
                    <span className="break-all font-mono text-[11px] leading-relaxed text-muted">
                      {hookMsg}
                    </span>
                  </Row>
                )}

                <Row
                  title={t("settings.approvalScanFallback")}
                  desc={t("settings.approvalScanFallbackHint")}
                >
                  <Switch
                    checked={settings.approval.scanFallback}
                    onChange={(v) => setApproval("scanFallback", v)}
                    label={t("settings.approvalScanFallback")}
                  />
                </Row>
              </>
            )}
          </Section>

          {/* Updates */}
          <Section id="updates" icon={<RefreshCw size={15} />} title={t("settings.updates")}>
            <Row title={t("settings.autoCheckUpdates")} desc={t("settings.autoCheckUpdatesHint")}>
              <Switch
                checked={settings.autoCheckUpdates}
                onChange={(v) => set("autoCheckUpdates", v)}
                label={t("settings.autoCheckUpdates")}
              />
            </Row>
            <Row
              title={t("settings.autoDownloadUpdates")}
              desc={t("settings.autoDownloadUpdatesHint")}
            >
              <Switch
                checked={settings.autoDownloadUpdates}
                onChange={(v) => set("autoDownloadUpdates", v)}
                label={t("settings.autoDownloadUpdates")}
              />
            </Row>
            <Row title={t("settings.currentVersion")}>
              <div className="flex items-center gap-3">
                <span className="rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg">
                  v{appVersion || "…"}
                </span>
                <CheckForUpdatesButton />
              </div>
            </Row>
          </Section>

          {/* Data */}
          <Section id="data" icon={<Database size={15} />} title={t("settings.data")}>
            <Row title={t("settings.exportLabel")} desc={t("settings.exportHint")} full>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[13px] text-fg">
                  <Switch
                    checked={includeSecrets}
                    onChange={setIncludeSecrets}
                    label={t("settings.includeSecrets")}
                  />
                  {t("settings.includeSecrets")}
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={dataBusy}
                  onClick={() => void doExport()}
                >
                  <Upload size={14} /> {t("settings.exportData")}
                </Button>
              </div>
            </Row>
            <Row title={t("settings.importLabel")} desc={t("settings.importHint")} full>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={dataBusy}
                  onClick={() => void doImport("merge")}
                >
                  <Download size={14} /> {t("settings.mergeImport")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={dataBusy}
                  onClick={() => void doImport("replace")}
                >
                  <Download size={14} /> {t("settings.replaceImport")}
                </Button>
              </div>
            </Row>
            {dataStatus && (
              <p className="break-all py-1 font-mono text-[11px] text-subtle">{dataStatus}</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
