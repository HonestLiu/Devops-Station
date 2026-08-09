import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Check, ChevronDown, ChevronUp, Upload, X } from "lucide-react";

import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { fonts } from "@/lib/api";
import { registerFontFromBase64 } from "@/lib/fontLoader";

/** Split a CSS font-family string into individual family names. */
function parseStack(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

interface FontPickerProps {
  value: string;
  onChange: (v: string) => void;
  importedFonts: string[];
  onImportedFontsChange: (v: string[]) => void;
}

export function FontPicker({
  value,
  onChange,
  importedFonts,
  onImportedFontsChange,
}: FontPickerProps) {
  const [available, setAvailable] = useState<string[]>([]);
  const [imported, setImported] = useState<string[]>(importedFonts);
  const [selected, setSelected] = useState<string[]>(() => parseStack(value));
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastEmitted = useRef(value);
  const fileRef = useRef<HTMLInputElement>(null);

  // Pull the live system + imported font catalog once.
  useEffect(() => {
    fonts.listFonts().then(setAvailable).catch(() => setAvailable([]));
    fonts.listImportedFonts().then(onImportedFontsChange).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the imported list in sync with the store (e.g. after a reset).
  useEffect(() => setImported(importedFonts), [importedFonts]);

  // Re-sync only when the value changes from the *outside* (e.g. Reset to defaults).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setSelected(parseStack(value));
    }
  }, [value]);

  const catalog = useMemo(() => {
    const set = new Set([...available, ...imported]);
    return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [available, imported]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((f) => !q || f.toLowerCase().includes(q));
  }, [catalog, query]);

  const emit = (next: string[]) => {
    setSelected(next);
    const joined = next.join(", ");
    lastEmitted.current = joined;
    onChange(joined);
  };

  const toggle = (f: string) =>
    emit(selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[i], next[j]] = [next[j], next[i]];
    emit(next);
  };

  const remove = (f: string) => emit(selected.filter((x) => x !== f));

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const b64 = await fileToBase64(file);
        const family = file.name.replace(/\.[^.]+$/, "");
        try {
          await fonts.importFont(family, b64);
          await registerFontFromBase64(family, b64);
          const nextImported = imported.includes(family)
            ? imported
            : [...imported, family];
          setImported(nextImported);
          onImportedFontsChange(nextImported);
          if (!selected.includes(family)) emit([...selected, family]);
        } catch (e) {
          console.error("font import failed", family, e);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    void importFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void importFiles(e.dataTransfer.files);
  };

  const previewStack = selected.join(", ") || "monospace";

  return (
    <div className="flex flex-col gap-3">
      {/* Selected stack, in priority order */}
      <div>
        <div className="mb-1 text-[11px] text-subtle">
          Active stack (top = highest priority)
        </div>
        {selected.length === 0 ? (
          <div className="rounded border border-dashed border-border px-3 py-2 text-[12px] text-subtle">
            No fonts selected — using browser default.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {selected.map((f, i) => (
              <li
                key={f}
                className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1.5"
              >
                <span
                  className="flex-1 truncate font-mono text-[12px]"
                  style={{ fontFamily: f }}
                  title={f}
                >
                  {f}
                </span>
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="text-muted hover:text-fg disabled:opacity-30"
                  title="Move up (higher priority)"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === selected.length - 1}
                  className="text-muted hover:text-fg disabled:opacity-30"
                  title="Move down (lower priority)"
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(f)}
                  className="text-muted hover:text-danger"
                  title="Remove"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Live preview */}
      <div className="rounded border border-border bg-bg px-3 py-2">
        <div
          className="truncate text-[15px] leading-relaxed"
          style={{ fontFamily: previewStack }}
        >
          The quick brown fox 敏捷的棕色狐狸 0123456789 {"{}[]$#"}
        </div>
        <div className="mt-0.5 text-[10px] text-subtle">Preview · {previewStack}</div>
      </div>

      {/* Import */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={cn(
          "flex items-center justify-center gap-2 rounded border border-dashed px-3 py-3 text-[12px]",
          drag ? "border-accent bg-accent/5" : "border-border",
        )}
      >
        <Upload size={14} className="text-muted" />
        <span className="text-muted">
          {busy ? "Importing…" : "Drag & drop font files (.ttf/.otf/.woff/.woff2) or"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          Import…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
          multiple
          hidden
          onChange={onInput}
        />
      </div>

      {/* Searchable catalog */}
      <div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fonts…"
          className="mb-2 text-[12px]"
        />
        <div className="max-h-56 overflow-y-auto rounded border border-border">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-subtle">No matching fonts.</div>
          ) : (
            filtered.map((f) => {
              const checked = selected.includes(f);
              const isImported = imported.includes(f);
              return (
                <div
                  key={f}
                  onClick={() => toggle(f)}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                  />
                  <span
                    className="flex-1 truncate font-mono text-[12px]"
                    style={{ fontFamily: f }}
                    title={f}
                  >
                    {f}
                  </span>
                  {isImported && (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      imported
                    </span>
                  )}
                  {checked && <Check size={13} className="text-accent" />}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
