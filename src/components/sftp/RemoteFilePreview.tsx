import { useEffect, useState } from "react";
import { AlertTriangle, Download, File as FileIcon, Loader2, Pencil } from "lucide-react";

import { sftp } from "@/lib/api";
import { Button, Dialog } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

type Kind = "markdown" | "text" | "image" | "pdf" | "video" | "audio" | "unsupported";

const MARKDOWN_EXT = new Set(["md", "markdown", "mdown", "mkdn", "mdwn", "litmd"]);
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tif", "tiff", "avif",
]);
const VIDEO_EXT = new Set([
  "mp4", "webm", "ogv", "ogg", "mov", "m4v", "mkv", "avi", "wmv", "flv",
]);
const AUDIO_EXT = new Set(["mp3", "wav", "oga", "opus", "m4a", "flac", "aac"]);
// Plain-text fallbacks when there's no clearer hint (configs, code, data).
const TEXT_EXT = new Set([
  "txt", "text", "log", "conf", "cfg", "config", "ini", "env", "properties", "props",
  "json", "yaml", "yml", "toml", "xml", "csv", "tsv", "tab", "sql",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "less", "html", "htm",
  "rs", "go", "c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "java", "kt", "kts",
  "swift", "php", "rb", "pl", "lua", "r", "scala", "dart", "vue", "svelte", "gradle",
  "gitignore", "gitattributes", "dockerfile", "makefile", "npmignore", "editorconfig",
  "lock", "diff", "patch", "tf", "tfvars", "yml", "vhost", "nginx", "conf",
]);

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
  tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", ogg: "video/ogg",
  mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  mp3: "audio/mpeg", wav: "audio/wav", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindOf(name: string): Kind {
  const e = extOf(name);
  if (MARKDOWN_EXT.has(e)) return "markdown";
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "pdf") return "pdf";
  if (VIDEO_EXT.has(e)) return "video";
  if (AUDIO_EXT.has(e)) return "audio";
  if (TEXT_EXT.has(e) || e === "") return "text";
  return "unsupported";
}

/** base64 (standard alphabet) → Uint8Array, in the browser. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface Props {
  sessionId: string;
  path: string;
  name: string;
  onClose: () => void;
  /** Open the file in the inline editor (when available). */
  onEdit?: (path: string, name: string) => void;
  /** Download the file to a local path. */
  onDownload?: (path: string, name: string) => void;
}

/**
 * In-app preview for a remote file. Tauri renders on a WebView, so common
 * formats can be shown natively: Markdown (reusing the release-notes renderer),
 * plain text, images, PDF, video and audio. Oversized or unsupported files fall
 * back to a download.
 */
export function RemoteFilePreview({
  sessionId,
  path,
  name,
  onClose,
  onEdit,
  onDownload,
}: Props) {
  const t = useT();
  const kind = kindOf(name);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    setDataUrl(null);
    setObjectUrl(null);

    (async () => {
      try {
        if (kind === "markdown" || kind === "text") {
          const content = await sftp.read(sessionId, path);
          if (cancelled) return;
          setText(content);
        } else {
          const b64 = await sftp.readBytes(sessionId, path);
          if (cancelled) return;
          const ext = extOf(name);
          if (kind === "image") {
            const mime = MIME[ext] ?? "application/octet-stream";
            setDataUrl(`data:${mime};base64,${b64}`);
          } else {
            const mime = MIME[ext] ?? "application/octet-stream";
            const bytes = base64ToBytes(b64);
            const ab = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(ab).set(bytes);
            const url = URL.createObjectURL(new Blob([ab], { type: mime }));
            setObjectUrl(url);
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, path, name, kind]);

  // Revoke any object URL we created when unmounting or switching files.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const footer = (
    <>
      <span className="mr-auto text-[11px] text-subtle">
        {kind === "markdown"
          ? "Markdown"
          : kind === "text"
            ? "Text"
            : kind === "image"
              ? "Image"
              : kind === "pdf"
                ? "PDF"
                : kind === "video"
                  ? "Video"
                  : kind === "audio"
                    ? "Audio"
                    : "—"}
      </span>
      {onEdit && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClose();
            onEdit(path, name);
          }}
        >
          <Pencil size={13} /> {t("sftp.previewEdit")}
        </Button>
      )}
      {onDownload && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onDownload(path, name);
            onClose();
          }}
        >
          <Download size={13} /> {t("sftp.previewDownloadInstead")}
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-4xl"
      title={t("sftp.previewTitle", { name })}
      description={path}
      footer={footer}
    >
      <div className="h-[72vh] overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-subtle">
            <Loader2 size={14} className="animate-spin text-accent" /> Loading…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertTriangle size={28} className="text-warning" />
            <p className="max-w-md text-[12px] leading-relaxed text-muted">
              {error.includes("too large")
                ? t("sftp.previewTooLarge")
                : t("sftp.previewReadError", { msg: error })}
            </p>
          </div>
        ) : kind === "markdown" ? (
          <div className="h-full overflow-auto select-text px-2 py-1 text-fg">
            <Markdown source={text ?? ""} />
          </div>
        ) : kind === "text" ? (
          <pre className="h-full overflow-auto select-text whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-3 font-mono text-[12px] leading-relaxed text-fg">
            {text}
          </pre>
        ) : kind === "image" ? (
          <div className="flex h-full items-center justify-center overflow-auto bg-black/5 p-2 dark:bg-black/30">
            <img
              src={dataUrl ?? ""}
              alt={name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : kind === "pdf" ? (
          <iframe src={objectUrl ?? ""} title={name} className="h-full w-full border-0" />
        ) : kind === "video" ? (
          <div className="flex h-full items-center justify-center bg-black/5 dark:bg-black/30">
            <video src={objectUrl ?? ""} controls className="max-h-full max-w-full" />
          </div>
        ) : kind === "audio" ? (
          <div className="flex h-full items-center justify-center p-6">
            <audio src={objectUrl ?? ""} controls className="w-full" />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <FileIcon size={28} className="text-subtle" />
            <p className="max-w-md text-[12px] leading-relaxed text-muted">
              {t("sftp.previewUnsupported")}
            </p>
            <span className="text-[11px] text-subtle">{extOf(name).toUpperCase() || "—"}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
