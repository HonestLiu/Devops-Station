import { useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";

import { localFs } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Inline formatting: `code`, **bold**, *italic*, [text](url)
 * ------------------------------------------------------------------ */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first so its contents are not re-parsed.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-bg px-1 py-0.5 font-mono text-[12px] text-accent"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      nodes.push(
        <em key={`${keyPrefix}-i${i}`}>{token.slice(1, -1)}</em>,
      );
    } else if (m[4]) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!;
      nodes.push(
        <a
          key={`${keyPrefix}-l${i}`}
          href={mm[2]}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
          // Open in the OS browser instead of navigating the webview.
          onClick={(e) => {
            e.preventDefault();
            void localFs.openUrl(mm[2]).catch(() => undefined);
          }}
        >
          {mm[1]}
        </a>,
      );
    }
    last = m.index + token.length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ------------------------------------------------------------------ *
 * Minimal syntax highlighter for code blocks.
 * ------------------------------------------------------------------ */

const KEYWORDS = new Set([
  "sudo", "apt", "yum", "dnf", "systemctl", "service", "journalctl", "grep",
  "cat", "ls", "cd", "echo", "export", "if", "then", "else", "fi", "for",
  "while", "do", "done", "function", "return", "import", "from", "def",
  "class", "const", "let", "var", "fn", "pub", "use", "match", "struct",
  "enum", "true", "false", "null", "None", "True", "False",
]);

function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize: comments, strings, numbers, words, other.
  const re =
    /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_])/gm;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code)) !== null) {
    const [tok, comment, str, num, word, ws, punct] = m;
    if (comment !== undefined) {
      out.push(
        <span key={k++} style={{ color: "var(--muted)" }}>
          {comment}
        </span>,
      );
    } else if (str !== undefined) {
      out.push(
        <span key={k++} style={{ color: "#9ece6a" }}>
          {str}
        </span>,
      );
    } else if (num !== undefined) {
      out.push(
        <span key={k++} style={{ color: "#ff9e64" }}>
          {num}
        </span>,
      );
    } else if (word !== undefined) {
      if (KEYWORDS.has(word)) {
        out.push(
          <span key={k++} style={{ color: "var(--accent)" }}>
            {word}
          </span>,
        );
      } else {
        out.push(<span key={k++}>{word}</span>);
      }
    } else if (ws !== undefined) {
      out.push(<span key={k++}>{ws}</span>);
    } else if (punct !== undefined) {
      out.push(
        <span key={k++} style={{ color: "var(--muted)" }}>
          {punct}
        </span>,
      );
    }
  }
  return out;
}

function CodeBlock({
  code,
  lang,
  onInsert,
  onRun,
}: {
  code: string;
  lang?: string;
  onInsert?: (code: string) => void;
  onRun?: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between bg-elevated px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">
          {lang || "code"}
        </span>
        <div className="flex items-center gap-2">
          {(onInsert || onRun) && (
            <>
              {onRun && (
                <button
                  onClick={() => onRun(code)}
                  className="text-[11px] font-medium text-amber-400 hover:text-amber-300"
                  title="Send this command to the terminal and run it"
                >
                  Run
                </button>
              )}
              {onInsert && (
                <button
                  onClick={() => onInsert(code)}
                  className="text-[11px] text-muted hover:text-fg"
                  title="Insert this command at the terminal prompt (does not run)"
                >
                  Insert
                </button>
              )}
            </>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-fg"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto bg-bg p-3 text-[12px] leading-relaxed">
        <code className="font-mono">{highlight(code)}</code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Block parser
 * ------------------------------------------------------------------ */

interface Block {
  type: "code" | "h1" | "h2" | "h3" | "ul" | "ol" | "quote" | "hr" | "p";
  content?: string;
  items?: string[];
  lang?: string;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", content: buf.join("\n"), lang });
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push({
        type: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
        content: h[2],
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote (consecutive > lines)
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", content: buf.join("\n") });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Paragraph (collect until blank line or block starter)
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", content: buf.join("\n") });
  }
  return blocks;
}

function renderBlock(
  b: Block,
  key: number,
  onInsert?: (code: string) => void,
  onRun?: (code: string) => void,
): ReactNode {
  switch (b.type) {
    case "code":
      return (
        <CodeBlock
          key={key}
          code={b.content || ""}
          lang={b.lang}
          onInsert={onInsert}
          onRun={onRun}
        />
      );
    case "h1":
      return (
        <h1 key={key} className="mb-1 mt-3 text-[16px] font-semibold text-fg">
          {renderInline(b.content || "", `h1-${key}`)}
        </h1>
      );
    case "h2":
      return (
        <h2 key={key} className="mb-1 mt-2 text-[14px] font-semibold text-fg">
          {renderInline(b.content || "", `h2-${key}`)}
        </h2>
      );
    case "h3":
      return (
        <h3 key={key} className="mb-1 mt-2 text-[13px] font-semibold text-fg">
          {renderInline(b.content || "", `h3-${key}`)}
        </h3>
      );
    case "ul":
      return (
        <ul key={key} className="my-1 list-disc space-y-0.5 pl-5 text-[13px]">
          {b.items!.map((it, j) => (
            <li key={j}>{renderInline(it, `ul-${key}-${j}`)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5 text-[13px]">
          {b.items!.map((it, j) => (
            <li key={j}>{renderInline(it, `ol-${key}-${j}`)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className="my-2 border-l-2 border-accent/50 bg-elevated px-3 py-1 text-[13px] text-muted"
        >
          {renderInline(b.content || "", `q-${key}`)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="my-3 border-border" />;
    case "p":
      return (
        <p key={key} className="my-1.5 text-[13px] leading-relaxed">
          {b.content!.split("\n").map((ln, j, arr) => (
            <span key={j}>
              {renderInline(ln, `p-${key}-${j}`)}
              {j < arr.length - 1 && <br />}
            </span>
          ))}
        </p>
      );
    default:
      return null;
  }
}

export function Markdown({
  content,
  onInsert,
  onRun,
}: {
  content: string;
  onInsert?: (code: string) => void;
  onRun?: (code: string) => void;
}) {
  const blocks = parseBlocks(content);
  return (
    <div className={cn("text-fg")}>
      {blocks.map((b, i) => renderBlock(b, i, onInsert, onRun))}
    </div>
  );
}
