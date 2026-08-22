import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Check,
  Code2,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Button, Dialog, EmptyState, Input, SideIconButton } from "@/components/ui";
import { injectCommandLines } from "@/ai/terminalAi";
import { useSnippetsStore } from "@/store/useSnippetsStore";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { Snippet, SnippetSortKey } from "@/lib/types";
import { SnippetDialog } from "./SnippetDialog";

type DialogState = { mode: "create" } | { mode: "edit"; snippet: Snippet };

/**
 * The Snippet sidebar — right-anchored panel matching the Files sidebar. Lists
 * the user's snippets with one-click Run, plus a toolbar with Create / Search /
 * Sort. `sessionId` pins Run to this tab's terminal; `terminalHint` tells the
 * AI which shell syntax to generate (PowerShell vs bash).
 */
export function SnippetPanel({
  onClose,
  sessionId,
  terminalHint,
}: {
  onClose: () => void;
  sessionId?: string | null;
  terminalHint: string;
}) {
  const t = useT();
  const snippets = useSnippetsStore((s) => s.snippets);
  const sort = useSnippetsStore((s) => s.sort);
  const setSort = useSnippetsStore((s) => s.setSort);
  const remove = useSnippetsStore((s) => s.remove);

  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? snippets.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.content.toLowerCase().includes(q),
        )
      : snippets;
    const sorted = [...filtered];
    switch (sort) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "created":
        sorted.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "updated":
        sorted.sort((a, b) => b.updatedAt - a.updatedAt);
        break;
    }
    return sorted;
  }, [snippets, search, sort]);

  const run = (s: Snippet) => {
    if (!s.content.trim()) return;
    void injectCommandLines(s.content, true, sessionId);
  };

  return (
    <div className="relative flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip h-6 w-6 shrink-0">
          <Code2 size={13} />
        </span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">
          {t("snippet.title")}
        </span>
        <SideIconButton
          label={t("snippet.close")}
          onClick={onClose}
          icon={<X size={14} />}
        />
      </div>

      {/* Toolbar: Create / Search / Sort settings */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border px-2">
        <div className="flex items-center gap-1">
          <SideIconButton
            label={t("snippet.create")}
            onClick={() => setDialog({ mode: "create" })}
            icon={<Plus size={14} />}
          />
          <SideIconButton
            label={t("snippet.search")}
            active={showSearch}
            onClick={() => setShowSearch((v) => !v)}
            icon={<Search size={14} />}
          />
        </div>
        <div className="relative">
          <SideIconButton
            label={t("snippet.sort")}
            active={sortOpen}
            onClick={() => setSortOpen((v) => !v)}
            icon={<ArrowUpDown size={14} />}
          />
          {sortOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 top-8 z-40 w-36 rounded-lg border border-border bg-elevated p-1 shadow-lg">
                {(["name", "created", "updated"] as SnippetSortKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setSort(k);
                      setSortOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover",
                      sort === k && "text-accent",
                    )}
                  >
                    {t(`snippet.sort.${k}`)}
                    {sort === k && <Check size={12} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search filter (collapsible) */}
      {showSearch && (
        <div className="border-b border-border px-2 py-1.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("snippet.searchPlaceholder")}
            autoFocus
            className="select-text"
          />
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          snippets.length === 0 ? (
            <EmptyState
              icon={<Code2 size={20} />}
              title={t("snippet.emptyTitle")}
              description={t("snippet.emptyHint")}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setDialog({ mode: "create" })}
                >
                  <Plus size={13} /> {t("snippet.create")}
                </Button>
              }
            />
          ) : (
            <p className="py-6 text-center text-[12px] text-subtle">
              {t("snippet.noMatches")}
            </p>
          )
        ) : (
          <div className="space-y-1.5">
            {visible.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg">
                    {s.name}
                  </div>
                  <code className="block truncate text-[11px] text-subtle">
                    {s.content}
                  </code>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => run(s)}
                  title={t("snippet.run")}
                >
                  <Play size={13} className="text-accent" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ mode: "edit", snippet: s })}
                  title={t("snippet.edit")}
                >
                  <Pencil size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(s)}
                  title={t("snippet.delete")}
                >
                  <Trash2 size={13} className="text-danger" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / edit dialog */}
      {dialog && (
        <SnippetDialog
          mode={dialog.mode}
          snippet={dialog.mode === "edit" ? dialog.snippet : undefined}
          terminalHint={terminalHint}
          onClose={() => setDialog(null)}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <Dialog
          open
          onClose={() => setDeleteTarget(null)}
          title={t("snippet.deleteTitle")}
          width="max-w-sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  remove(deleteTarget.id);
                  setDeleteTarget(null);
                }}
              >
                <Trash2 size={13} /> {t("snippet.deleteConfirm")}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-fg">
            {t("snippet.deleteBody", { name: deleteTarget.name })}
          </p>
        </Dialog>
      )}
    </div>
  );
}
