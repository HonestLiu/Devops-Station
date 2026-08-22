import { useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";

import { Button, Dialog, Field, Input, Textarea } from "@/components/ui";
import { completeText } from "@/ai/client";
import { currentProvider, hasAiConfig } from "@/ai/useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useT } from "@/i18n";
import type { Snippet } from "@/lib/types";

/**
 * Create / edit a snippet. The top bar lets the user describe the task in
 * natural language and hit the AI button to auto-generate the Name + Content
 * fields; both fields are also directly editable by hand before saving.
 */
export function SnippetDialog({
  mode,
  snippet,
  terminalHint,
  onClose,
}: {
  mode: "create" | "edit";
  /** Present when `mode === "edit"`. */
  snippet?: Snippet;
  /** `getTerminalTypeDescription(...)` so the AI picks the right shell syntax. */
  terminalHint: string;
  onClose: () => void;
}) {
  const t = useT();
  const [requirement, setRequirement] = useState("");
  const [name, setName] = useState(snippet?.name ?? "");
  const [content, setContent] = useState(snippet?.content ?? "");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    const req = requirement.trim();
    if (!req || !hasAiConfig()) return;
    setAiBusy(true);
    setAiError(null);
    const { text, error: err } = await completeText({
      provider: currentProvider(),
      messages: [
        {
          role: "system",
          content: `You write terminal command snippets. The user describes a task in natural language.
Return ONLY a JSON object with two fields:
- "name": a short label for the snippet, at most 40 characters, no newlines
- "content": the shell command(s) to run, one command per line
No markdown, no fences, no explanation — only the JSON object.
${terminalHint}`,
        },
        { role: "user", content: req },
      ],
    });
    setAiBusy(false);
    if (err) {
      setAiError(err);
      return;
    }
    const parsed = parseSnippetJson(text);
    if (parsed) {
      setName(parsed.name);
      setContent(parsed.content);
    } else {
      // Defensive fallback: the model did not return clean JSON — use the first
      // non-blank line as the name and keep the raw text as content.
      const lines = text
        .split(/\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      setName(lines[0]?.slice(0, 48) || t("snippet.untitled"));
      setContent(text.trim());
    }
  };

  const submit = () => {
    const n = name.trim();
    const c = content.trim();
    if (!n || !c) {
      setError(t("snippet.required"));
      return;
    }
    const next: Snippet = {
      id: mode === "edit" && snippet ? snippet.id : crypto.randomUUID(),
      name: n,
      content: c,
      createdAt: mode === "edit" && snippet ? snippet.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    useSnippetsStore.getState().upsert(next);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "edit" ? t("snippet.editTitle") : t("snippet.newTitle")}
      description={t("snippet.dialogDesc")}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {mode === "edit" ? t("common.save") : t("snippet.create")}
          </Button>
        </>
      }
    >
      {/* AI generation bar */}
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-bg p-2">
        <Input
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder={t("snippet.requirementPh")}
          className="select-text"
          onKeyDown={(e) => {
            if (e.key === "Enter") void generate();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={aiBusy || !hasAiConfig()}
          onClick={() => void generate()}
          title={t("snippet.ai")}
        >
          {aiBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Sparkles size={13} />
          )}
          {t("snippet.ai")}
        </Button>
      </div>

      {/* AI not configured: show the setup hint instead of a dead button. */}
      {!hasAiConfig() && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[12px] text-fg">
          <AlertTriangle size={13} className="shrink-0 text-warning" />
          <span className="truncate">{t("ai.needSetup")}</span>
          <button
            onClick={() => useAppStore.getState().setPage("settings")}
            className="ml-auto shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90"
          >
            {t("ai.goSettings")}
          </button>
        </div>
      )}
      {aiError && (
        <p className="mb-2 text-[11px] text-danger">
          {t("snippet.aiError", { err: aiError })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3">
        <Field label={t("snippet.name")}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("snippet.namePh")}
            className="select-text"
          />
        </Field>
        <Field label={t("snippet.content")} hint={t("snippet.contentHint")}>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            placeholder={t("snippet.contentPh")}
            className="select-text"
          />
        </Field>
      </div>
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
    </Dialog>
  );
}

/**
 * Extract a `{name, content}` snippet from the model's reply, tolerating
 * markdown fences, surrounding prose, or a plain JSON object.
 */
function parseSnippetJson(
  text: string,
): { name: string; content: string } | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
      name?: unknown;
      content?: unknown;
    };
    if (
      typeof obj?.name === "string" &&
      obj.name.trim() &&
      typeof obj?.content === "string" &&
      obj.content.trim()
    ) {
      return { name: obj.name.trim(), content: obj.content.trim() };
    }
    return null;
  } catch {
    return null;
  }
}
