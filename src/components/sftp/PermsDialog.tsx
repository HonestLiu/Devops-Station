import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import { sftp } from "@/lib/api";
import { Button, Dialog, Field, Input } from "@/components/ui";
import type { RemoteFile } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
  file: RemoteFile;
  onClose: () => void;
  onApplied?: () => void;
}

// Permission bit masks (only the 9 rwx bits we expose in the UI).
const BITS = [
  { label: "Owner", flag: 0o400, write: 0o200, exec: 0o100 },
  { label: "Group", flag: 0o40, write: 0o20, exec: 0o10 },
  { label: "Other", flag: 0o4, write: 0o2, exec: 0o1 },
] as const;

function BitRow({
  label,
  mode,
  flag,
  write,
  exec,
  onChange,
}: {
  label: string;
  mode: number;
  flag: number;
  write: number;
  exec: number;
  onChange: (next: number) => void;
}) {
  const toggle = (bit: number, on: boolean) =>
    onChange(on ? mode | bit : mode & ~bit);
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[12px] font-medium text-muted">{label}</span>
      <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
        <input
          type="checkbox"
          checked={(mode & flag) !== 0}
          onChange={(e) => toggle(flag, e.target.checked)}
          className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
        />
        r
      </label>
      <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
        <input
          type="checkbox"
          checked={(mode & write) !== 0}
          onChange={(e) => toggle(write, e.target.checked)}
          className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
        />
        w
      </label>
      <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
        <input
          type="checkbox"
          checked={(mode & exec) !== 0}
          onChange={(e) => toggle(exec, e.target.checked)}
          className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
        />
        x
      </label>
    </div>
  );
}

/**
 * chmod / chown editor for a remote file. Reads current metadata via `sftp_stat`,
 * lets the user tweak the mode (octal + rwx checkboxes) and owner/group, then
 * applies it with `sftp_set_perms`.
 */
export function PermsDialog({ sessionId, file, onClose, onApplied }: Props) {
  // Only the 12 permission-related bits (0o7777) are editable; strip the
  // file-type bits that `stat` may report.
  const [mode, setMode] = useState(0);
  const [octalText, setOctalText] = useState("0000");
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await sftp.stat(sessionId, file.path);
        if (cancelled) return;
        const m = meta.permissions & 0o7777;
        setMode(m);
        setOctalText(toOctal(m));
        setOwner(meta.owner ?? "");
        setGroup(meta.group ?? "");
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, file.path]);

  const onOctal = (raw: string) => {
    const clean = raw.replace(/[^0-7]/g, "").slice(0, 4);
    setOctalText(clean);
    const parsed = parseInt(clean || "0", 8);
    if (!Number.isNaN(parsed)) setMode(parsed & 0o7777);
  };

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      // Re-derive from the octal field so it's always the source of truth.
      const m = parseInt(octalText || "0", 8) & 0o7777;
      await sftp.setPerms(
        sessionId,
        file.path,
        m,
        owner.trim() || null,
        group.trim() || null,
      );
      onApplied?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-md"
      title="Permissions"
      description={file.path}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={apply}
            disabled={loading || applying}
          >
            {applying ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
            Apply
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-subtle">
          <Loader2 size={14} className="animate-spin text-accent" /> Loading permissions…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Mode (octal)" hint="0–7777. Type the numeric mode or use the checkboxes.">
            <Input
              value={octalText}
              onChange={(e) => onOctal(e.target.value)}
              className="font-mono"
              inputMode="numeric"
            />
          </Field>

          <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg/40 p-3">
            {BITS.map((b) => (
              <BitRow
                key={b.label}
                label={b.label}
                mode={mode}
                flag={b.flag}
                write={b.write}
                exec={b.exec}
                onChange={(next) => {
                  setMode(next);
                  setOctalText(toOctal(next));
                }}
              />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner" hint="Name or numeric uid (resolved via `id -u`).">
              <Input value={owner} onChange={(e) => setOwner(e.target.value)} />
            </Field>
            <Field label="Group" hint="Name or numeric gid (resolved via `id -g`).">
              <Input value={group} onChange={(e) => setGroup(e.target.value)} />
            </Field>
          </div>

          {error && (
            <p className={cn("text-[11px] text-danger")}>{error}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function toOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}
