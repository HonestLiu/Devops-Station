import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";

import { sftp } from "@/lib/api";
import { Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/utils";

const EDIT_LIMIT = 4 * 1024 * 1024;

interface Props {
  sessionId: string;
  path: string;
  name: string;
  onClose: () => void;
  /** Called after a successful save so the parent can refresh the listing. */
  onSaved?: () => void;
  /** Fall back to a binary download when the file is too large / non-text. */
  onDownload?: (path: string, name: string) => void;
}

/**
 * Modal editor for a remote text file. Reads the file via `sftp_read`, lets the
 * user edit it, and writes the result back with `sftp_write`. Oversized or
 * binary files are rejected by the backend so the caller can download instead.
 */
export function RemoteFileEditor({
  sessionId,
  path,
  name,
  onClose,
  onSaved,
  onDownload,
}: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const text = await sftp.read(sessionId, path);
        if (cancelled) return;
        setContent(text);
        setOriginal(text);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  const dirty = content !== original;
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const lines = useMemo(() => content.split("\n").length, [content]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await sftp.write(sessionId, path, content);
      setSavedAt(Date.now());
      setOriginal(content);
      onSaved?.();
      // Give the user a beat to see "Saved", then close.
      window.setTimeout(onClose, 600);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title={`Edit — ${name}`}
      description={path}
      footer={
        <>
          {loadError ? (
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <span className="mr-auto text-[11px] text-subtle">
                {bytes.toLocaleString()} bytes · {lines.toLocaleString()} lines
                {dirty && savedAt === null && " · unsaved"}
                {savedAt !== null && " · saved"}
              </span>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={saving || !dirty}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </Button>
            </>
          )}
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-subtle">
          <Loader2 size={14} className="animate-spin text-accent" /> Reading {name}…
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle size={28} className="text-warning" />
          <p className="max-w-sm text-[12px] leading-relaxed text-muted">
            {loadError}
          </p>
          {onDownload && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onDownload(path, name);
                onClose();
              }}
            >
              Download instead
            </Button>
          )}
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setSavedAt(null);
          }}
          spellCheck={false}
          autoFocus
          className={cn(
            "h-[52vh] w-full resize-none rounded-lg border border-border bg-bg p-3",
            "font-mono text-[12px] leading-relaxed text-fg",
            "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
            "tabular-nums",
          )}
        />
      )}
      {saveError && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
          <AlertTriangle size={12} /> {saveError}
        </p>
      )}
    </Dialog>
  );
}
