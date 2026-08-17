import { useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Minimal JS editor for widget parse/publish functions.
 * A transparent <pre> overlay renders syntax highlighting above a textarea;
 * the two scroll in lockstep. Good enough for small snippets without pulling
 * in a full editor dependency.
 */

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:const|let|var|return|function|if|else|new|typeof|Number|String|Object|Boolean|Array|JSON|true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)/g;

function highlight(code: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(code); m; m = TOKEN_RE.exec(code)) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span style="color:#6a9955">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span style="color:#ce9178">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span style="color:#569cd6">${esc(m[3])}</span>`;
    else out += `<span style="color:#b5cea8">${esc(m[4])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

export function MiniEditor({
  value,
  onChange,
  height = 140,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  height?: number;
  className?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const numRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lines = value.split("\n").length;

  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (numRef.current) numRef.current.scrollTop = ta.scrollTop;
  };

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-md border border-border/70 bg-[#1e1e1e] font-mono text-[12px] leading-[1.5]",
        className,
      )}
      style={{ height }}
    >
      {/* line numbers */}
      <div
        ref={numRef}
        className="shrink-0 select-none overflow-hidden border-r border-white/10 bg-[#252526] px-2 py-2 text-right text-[#858585]"
        style={{ width: 40 }}
        aria-hidden
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* editor + highlight overlay */}
      <div className="relative min-w-0 flex-1">
        <pre
          ref={preRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre px-2 py-2 text-[#d4d4d4]"
        >
          <code dangerouslySetInnerHTML={{ __html: highlight(value) + "\n" }} />
        </pre>
        <textarea
          ref={taRef}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          // Text itself is transparent — the highlight <pre> underneath shows
          // the tokens; only the caret stays visible.
          className="absolute inset-0 resize-none overflow-auto whitespace-pre bg-transparent px-2 py-2 text-transparent caret-white outline-none"
        />
      </div>
    </div>
  );
}
