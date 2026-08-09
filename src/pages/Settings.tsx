import { useState, type ReactNode } from "react";
import { Check, RotateCcw, Type } from "lucide-react";

import { Button, Checkbox, Field, Input, Select } from "@/components/ui";
import { FontDialog } from "@/components/FontDialog";
import { cn } from "@/lib/utils";
import { THEME_LIST } from "@/lib/themes";
import { useAppStore } from "@/store/useAppStore";
import type { AppSettings } from "@/store/useAppStore";
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

export function Settings() {
  const settings = useAppStore((s) => s.settings);
  const updateSetting = useAppStore((s) => s.updateSetting);
  const resetSettings = useAppStore((s) => s.resetSettings);
  const [fontOpen, setFontOpen] = useState(false);

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    void updateSetting(k, v);

  const setAi = <K extends keyof AISettings>(k: K, v: AISettings[K]) =>
    void updateSetting("ai", { ...settings.ai, [k]: v });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Appearance, terminal, connections and AI</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void resetSettings()}>
          <RotateCcw size={14} /> Reset to defaults
        </Button>
      </div>

      <div className="max-w-3xl space-y-4">
        {/* Theme */}
        <Section title="Appearance">
          <Field label="Theme" className="sm:col-span-2">
            <div className="flex flex-wrap gap-2">
              {THEME_LIST.map((t) => {
                const active = settings.theme === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => set("theme", t.id as ThemeId)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors",
                      active
                        ? "border-accent bg-accent/10 text-fg"
                        : "border-border bg-bg text-muted hover:bg-hover",
                    )}
                  >
                    <span className="flex overflow-hidden rounded">
                      {t.swatch.map((c, i) => (
                        <span
                          key={i}
                          className="h-3.5 w-3.5"
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </span>
                    {t.label}
                    {active && <Check size={13} className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </Field>
        </Section>

        {/* Terminal */}
        <Section title="Terminal">
          <Field
            label="Font family"
            hint="Pick from installed fonts or import your own. Top of the list wins; the app also keeps a CJK fallback."
          >
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFontOpen(true)}
              >
                <Type size={14} /> Configure fonts…
              </Button>
              <span className="truncate font-mono text-[11px] text-subtle" title={settings.fontFamily}>
                {settings.fontFamily}
              </span>
            </div>
            <FontDialog open={fontOpen} onClose={() => setFontOpen(false)} />
          </Field>
          <Field label="Font size (px)" hint="Recommended: JetBrainsMono Nerd Font">
            <Input
              type="number"
              min={8}
              max={32}
              value={settings.fontSize}
              onChange={(e) => set("fontSize", Number(e.target.value) || 13)}
            />
          </Field>
          <Field label="Line height">
            <Input
              type="number"
              step={0.05}
              min={1}
              max={2}
              value={settings.lineHeight}
              onChange={(e) => set("lineHeight", Number(e.target.value) || 1.25)}
            />
          </Field>
          <Field label="Scrollback lines">
            <Input
              type="number"
              step={1000}
              min={500}
              max={100000}
              value={settings.scrollback}
              onChange={(e) => set("scrollback", Number(e.target.value) || 10000)}
            />
          </Field>
          <Field label="Cursor style">
            <Select
              value={settings.cursorStyle}
              onChange={(e) =>
                set("cursorStyle", e.target.value as AppSettings["cursorStyle"])
              }
            >
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </Select>
          </Field>
          <div className="flex flex-col justify-center gap-2">
            <Checkbox
              label="Cursor blink"
              checked={settings.cursorBlink}
              onChange={(v) => set("cursorBlink", v)}
            />
            <Checkbox
              label="Copy on selection"
              checked={settings.copyOnSelect}
              onChange={(v) => set("copyOnSelect", v)}
            />
            <Checkbox
              label="Confirm before closing a tab"
              checked={settings.confirmOnClose}
              onChange={(v) => set("confirmOnClose", v)}
            />
          </div>
        </Section>

        {/* Monitoring */}
        <Section title="Monitoring">
          <Field label="Metrics poll interval">
            <Select
              value={settings.metricsInterval}
              onChange={(e) => set("metricsInterval", Number(e.target.value))}
            >
              <option value={1000}>1 second</option>
              <option value={2000}>2 seconds</option>
              <option value={5000}>5 seconds</option>
            </Select>
          </Field>
        </Section>

        {/* AI Assistant */}
        <Section title="AI Assistant">
          <Field label="Provider">
            <Select
              value={settings.ai.provider}
              onChange={(e) =>
                setAi("provider", e.target.value as AIProviderKind)
              }
            >
              <option value="openai">OpenAI (compatible)</option>
              <option value="ollama">Ollama (local)</option>
              <option value="custom">Custom API</option>
            </Select>
          </Field>
          <Field
            label="Base URL"
            hint="OpenAI: https://api.openai.com/v1 · Ollama: http://localhost:11434"
          >
            <Input
              value={settings.ai.baseUrl}
              onChange={(e) => setAi("baseUrl", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label="API key" hint="Stored locally. Leave empty for Ollama.">
            <Input
              type="password"
              value={settings.ai.apiKey}
              onChange={(e) => setAi("apiKey", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label="Model">
            <Input
              value={settings.ai.model}
              onChange={(e) => setAi("model", e.target.value)}
              className="font-mono text-[12px]"
            />
          </Field>
          <Field label="Temperature">
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
              label="Attach terminal context to messages"
              checked={settings.ai.terminalContext}
              onChange={(v) => setAi("terminalContext", v)}
            />
            <Checkbox
              label="Use local knowledge base to augment prompts"
              checked={settings.ai.useKnowledgeBase}
              onChange={(v) => setAi("useKnowledgeBase", v)}
            />
          </div>
          <Field
            label="Knowledge base path"
            hint="Local folder scanned for .md/.txt/.log/.json/.yaml etc. Used when the toggle above is on."
          >
            <Input
              value={settings.ai.knowledgeBasePath}
              onChange={(e) => setAi("knowledgeBasePath", e.target.value)}
              className="font-mono text-[12px]"
              placeholder="/path/to/docs"
            />
          </Field>
        </Section>
      </div>
    </div>
  );
}
