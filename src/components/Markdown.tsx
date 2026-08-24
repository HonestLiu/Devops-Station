import { type ReactNode } from "react";

/**
 * Minimal, safe Markdown renderer for (trusted-but-remote) release notes.
 *
 * It builds React elements instead of using `dangerouslySetInnerHTML`, so the
 * note text can never inject raw HTML — the only "remote" surface here is the
 * GitHub Releases `notes` field, and we still escape by construction. Links are
 * restricted to http(s)/mailto.
 *
 * Supported: headings (#–######), unordered/ordered lists, block quotes,
 * fenced code blocks, horizontal rules, GFM tables, and inline `code` /
 * **bold** / *italic* / [links](url).
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline-level parsing: code, bold, italic, links. */
function parseInline(text: string, keyBase: string): ReactNode[] {
  const result: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let k = 0;

  const flush = () => {
    if (buf) {
      result.push(buf);
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // inline code `...`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        result.push(
          <code key={`${keyBase}-c${k++}`} className="rounded bg-black/20 px-1 py-0.5 font-mono text-[11px]">
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    // link [text](url)
    if (ch === "[") {
      const close = text.indexOf("]", i);
      const paren = close !== -1 ? text.indexOf("(", close) : -1;
      const parenEnd = paren !== -1 ? text.indexOf(")", paren) : -1;
      if (close !== -1 && paren !== -1 && parenEnd !== -1) {
        flush();
        const label = text.slice(i + 1, close);
        const url = text.slice(paren + 1, parenEnd);
        const safe = SAFE_URL.test(url);
        result.push(
          safe ? (
            <a
              key={`${keyBase}-a${k++}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              {parseInline(label, `${keyBase}-a${k}`)}
            </a>
          ) : (
            <span key={`${keyBase}-a${k++}`}>{label}</span>
          )
        );
        i = parenEnd + 1;
        continue;
      }
    }

    // bold **...**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        result.push(
          <strong key={`${keyBase}-b${k++}`} className="font-semibold">
            {parseInline(text.slice(i + 2, end), `${keyBase}-b${k}`)}
          </strong>
        );
        i = end + 2;
        continue;
      }
    }

    // italic *...*
    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        result.push(
          <em key={`${keyBase}-i${k++}`} className="italic">
            {parseInline(text.slice(i + 1, end), `${keyBase}-i${k}`)}
          </em>
        );
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return result;
}

const HEADING_CLS = [
  "text-base font-semibold",
  "text-[15px] font-semibold",
  "text-sm font-semibold",
  "text-[13px] font-semibold",
  "text-[13px] font-medium",
  "text-[12px] font-medium",
];

/** Block-level parsing. */
function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(
        <p key={`p${key++}`} className="my-1 leading-relaxed">
          {parseInline(para.join(" "), `p${key}`)}
        </p>
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, idx) => (
        <li key={idx} className="my-0.5">
          {parseInline(it, `li${key}-${idx}`)}
        </li>
      ));
      out.push(
        list.ordered ? (
          <ol key={`ol${key++}`} className="my-1 list-decimal pl-5">
            {items}
          </ol>
        ) : (
          <ul key={`ul${key++}`} className="my-1 list-disc pl-5">
            {items}
          </ul>
        )
      );
      list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushPara();
      flushList();
      i++;
      continue;
    }

    // fenced code block
    if (trimmed.startsWith("```")) {
      flushPara();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(
        <pre
          key={`code${key++}`}
          className="my-2 max-h-40 overflow-auto rounded-lg border border-border bg-black/30 p-3 text-[11px] leading-relaxed"
        >
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      out.push(
        <div key={`h${key++}`} className={`${HEADING_CLS[level - 1]} mt-2 mb-1 text-fg`}>
          {parseInline(h[2], `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push(<hr key={`hr${key++}`} className="my-2 border-border" />);
      i++;
      continue;
    }

    // block quote
    if (trimmed.startsWith(">")) {
      flushPara();
      flushList();
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote key={`bq${key++}`} className="my-2 border-l-2 border-accent/50 pl-3 text-muted">
          {parseInline(quote.join(" "), `bq${key}`)}
        </blockquote>
      );
      continue;
    }

    // unordered list item
    const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
      i++;
      continue;
    }

    // ordered list item
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
      i++;
      continue;
    }

    // table: a row of `|`-separated cells followed by a separator row
    // (`| :--- | ---: |`). Detected when the next line is a separator.
    if (trimmed.includes("|") && i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (/^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(nextTrimmed)) {
        flushPara();
        flushList();
        const header = splitRow(trimmed);
        const aligns = splitRow(nextTrimmed).map(parseAlign);
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
          bodyRows.push(splitRow(lines[i].trim()));
          i++;
        }
        out.push(
          <div key={`tbl${key++}`} className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  {header.map((c, ci) => (
                    <th
                      key={ci}
                      className="border border-border bg-black/20 px-2 py-1 text-left font-semibold"
                      style={{ textAlign: aligns[ci] ?? "left" }}
                    >
                      {parseInline(c, `th${key}-${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((c, ci) => (
                      <td
                        key={ci}
                        className="border border-border px-2 py-1 align-top"
                        style={{ textAlign: aligns[ci] ?? "left" }}
                      >
                        {parseInline(c, `td${key}-${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // paragraph text
    para.push(trimmed);
    i++;
  }

  flushPara();
  flushList();
  return out;
}

/** Split a GFM table row into cell strings (handles optional leading/trailing `|`). */
function splitRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((c) => c.trim());
}

/** Parse a separator cell (`---`, `:---`, `:---:`, `---:`) into a text-align. */
function parseAlign(cell: string): "left" | "center" | "right" | undefined {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={className}>{parseBlocks(source)}</div>;
}
