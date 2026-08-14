import { useEffect, useState, type ReactNode } from "react";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { Check, Download, RotateCcw, Type, Upload } from "lucide-react";

import { Button, Checkbox, Field, Input, Select } from "@/components/ui";
import { FontDialog } from "@/components/FontDialog";
import { profile } from "@/lib/api";
import { isWindows } from "@/lib/platform";
import { formatShortcut } from "@/lib/shortcut";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { THEME_LIST } from "@/lib/themes";
import { useAppStore, type AppSettings, type Language } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import type { AIProviderKind, AISettings, ThemeId } from "@/lib/types";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
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

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        return;
      }
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      if (e.metaKey) mods.push("meta");
      onChange([...mods, e.code].join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <button
      type="button"
      onClick={() => setRecording((v) => !v)}
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
  const updateSetting = useAppStore((s) => s.updateSetting);
  const resetSettings = useAppStore((s) => s.resetSettings);
  const [fontOpen, setFontOpen] = useState(false);

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    void updateSetting(k, v);

  const setAi = <K extends keyof AISettings>(k: K, v: AISettings[K]) =>
    void updateSetting("ai", { ...settings.ai, [k]: v });

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

      <div className="max-w-3xl space-y-4">
        {/* Theme */}
        <Section title={t("settings.appearance")}>
          <Field label={t("settings.language")} className="sm:col-span-2">
            <Select
              value={settings.language}
              onChange={(e) => set("language", e.target.value as Language)}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label={t("settings.theme")} className="sm:col-span-2">
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
                        <span
                          key={i}
                          className="h-3.5 w-3.5"
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </span>
                    {th.label}
                    {active && <Check size={13} className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </Field>
        </Section>

        {/* Terminal */}
        <Section title={t("settings.terminal")}>
          <Field label={t("settings.fontFamily")} hint={t("settings.fontHint")}>
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFontOpen(true)}
              >
                <Type size={14} /> {t("settings.configureFonts")}
              </Button>
              <span className="truncate font-mono text-[11px] text-subtle" title={settings.fontFamily}>
                {settings.fontFamily}
              </span>
            </div>
            <FontDialog open={fontOpen} onClose={() => setFontOpen(false)} />
          </Field>
          <Field label={t("settings.fontSize")} hint={t("settings.fontRecommended")}>
            <Input
              type="number"
              min={8}
              max={32}
              value={settings.fontSize}
              onChange={(e) => set("fontSize", Number(e.target.value) || 13)}
            />
          </Field>
          <Field label={t("settings.lineHeight")}>
            <Input
              type="number"
              step={0.05}
              min={1}
              max={2}
              value={settings.lineHeight}
              onChange={(e) => set("lineHeight", Number(e.target.value) || 1.25)}
            />
          </Field>
          <Field label={t("settings.scrollback")}>
            <Input
              type="number"
              step={1000}
              min={500}
              max={100000}
              value={settings.scrollback}
              onChange={(e) => set("scrollback", Number(e.target.value) || 10000)}
            />
          </Field>
          <Field label={t("settings.cursorStyle")}>
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
          </Field>
          <div className="flex flex-col justify-center gap-2">
            <Checkbox
              label={t("settings.cursorBlink")}
              checked={settings.cursorBlink}
              onChange={(v) => set("cursorBlink", v)}
            />
            <Checkbox
              label={t("settings.copyOnSelect")}
              checked={settings.copyOnSelect}
              onChange={(v) => set("copyOnSelect", v)}
            />
            <Checkbox
              label={t("settings.confirmClose")}
              checked={settings.confirmOnClose}
              onChange={(v) => set("confirmOnClose", v)}
            />
          </div>
        </Section>

        {/* Monitoring */}
        <Section title={t("settings.monitoring")}>
          <Field label={t("settings.metricsInterval")}>
            <Select
              value={settings.metricsInterval}
              onChange={(e) => set("metricsInterval", Number(e.target.value))}
            >
              <option value={1000}>{t("settings.opt1s")}</option>
              <option value={2000}>{t("settings.opt2s")}</option>
              <option value={5000}>{t("settings.opt5s")}</option>
            </Select>
          </Field>
        </Section>

        {/* AI Assistant */}
        <Section title={t("settings.aiAssistant")}>
          <Field label={t("settings.provider")}>
            <Select
              value={settings.ai.provider}
              onChange={(e) =>
                setAi("provider", e.target.value as AIProviderKind)
              }
            >
              <option value="openai">{t("settings.optOpenAI")}</option>
              <option value="ollama">{t("settings.optOllama")}</option>
              <option value="custom">{t("settings.optCustom")}</option>
            </Select>
          </Field>
          <Field label={t("settings.baseUrl")} hint={t("settings.baseUrlHint")}>
            <Input
              value={settings.ai.baseUrl}
              onChange={(e) => setAi("baseUrl", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label={t("settings.apiKey")} hint={t("settings.apiKeyHint")}>
            <Input
              type="password"
              value={settings.ai.apiKey}
              onChange={(e) => setAi("apiKey", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label={t("settings.model")}>
            <Input
              value={settings.ai.model}
              onChange={(e) => setAi("model", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label={t("settings.temperature")}>
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={settings.ai.temperature}
              onChange={(e) =>
                setAi("temperature", Number(e.target.value) || 0.3)
              }
            />
          </Field>
          <div className="flex flex-col justify-center gap-2 sm:col-span-2">
            <Checkbox
              label={t("settings.terminalContext")}
              checked={settings.ai.terminalContext}
              onChange={(v) => setAi("terminalContext", v)}
            />
            <Checkbox
              label={t("settings.errorHints")}
              checked={settings.ai.errorHints}
              onChange={(v) => setAi("errorHints", v)}
            />
            <Checkbox
              label={t("settings.useKb")}
              checked={settings.ai.useKnowledgeBase}
              onChange={(v) => setAi("useKnowledgeBase", v)}
            />
          </div>
          <Field label={t("settings.kbPath")} hint={t("settings.kbHint")}>
            <Input
              value={settings.ai.knowledgeBasePath}
              onChange={(e) => setAi("knowledgeBasePath", e.target.value)}
              className="font-mono text-[12px]"
              placeholder={t("settings.kbPathPh")}
            />
          </Field>
        </Section>

        {/* Local Shell */}
        <Section title={t("settings.localShell")}>
          <Field label={t("settings.defaultShell")} hint={t("settings.shellHint")}>
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
          </Field>
        </Section>

        {/* J-Link */}
        <Section title={t("settings.jlink")}>
          <Field
            label={t("settings.jlinkPath")}
            hint={t("settings.jlinkHint")}
            className="sm:col-span-2"
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
                size="sm"
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
              >
                {t("settings.browse")}
              </Button>
            </div>
          </Field>
        </Section>

        {/* Shortcuts */}
        <Section title={t("settings.shortcuts")}>
          <Field
            label={t("settings.approveShortcut")}
            hint={t("settings.approveShortcutHint")}
            className="sm:col-span-2"
          >
            <ShortcutRecorder
              value={settings.approveShortcut}
              onChange={(v) => set("approveShortcut", v)}
              recordHint={t("settings.shortcutRecordHint")}
              pressHint={t("settings.shortcutPress")}
            />
          </Field>
        </Section>

        {/* Data */}
        <Section title={t("settings.data")}>
          <Field label={t("settings.exportLabel")} hint={t("settings.exportHint")} className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-3">
              <Checkbox
                label={t("settings.includeSecrets")}
                checked={includeSecrets}
                onChange={setIncludeSecrets}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={dataBusy}
                onClick={() => void doExport()}
              >
                <Download size={14} /> {t("settings.exportData")}
              </Button>
            </div>
          </Field>
          <Field label={t("settings.importLabel")} hint={t("settings.importHint")} className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={dataBusy}
                onClick={() => void doImport("merge")}
              >
                <Upload size={14} /> {t("settings.mergeImport")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={dataBusy}
                onClick={() => void doImport("replace")}
              >
                <Upload size={14} /> {t("settings.replaceImport")}
              </Button>
            </div>
          </Field>
          {dataStatus && (
            <p className="break-all font-mono text-[11px] text-subtle sm:col-span-2">
              {dataStatus}
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}
