import { type ReactNode } from "react";

/**
 * A small, dependency-free syntax highlighter used for code previews
 * (C export dialog, SFTP file viewer, …). It tokenises the source line by
 * line and wraps tokens in <span>s coloured with theme CSS variables
 * (`rgb(var(--c-…))`) so the highlighting stays readable in BOTH light and
 * dark themes.
 *
 * No external grammar/theme files are pulled in (keeps the bundle small and
 * avoids the licensing/maintenance overhead of highlight.js / prism / shiki).
 * The grammar is intentionally pragmatic: it handles the constructs that
 * actually appear in the generated C / CMake code and common config files.
 */

export type CodeLang =
  | "c"
  | "cpp"
  | "cmake"
  | "sh"
  | "json"
  | "yaml"
  | "xml"
  | "toml"
  | "text";

const C_KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do",
  "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
  "int", "long", "register", "restrict", "return", "short", "signed",
  "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned",
  "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary",
  // C99/C11 fixed-width types & common macros
  "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t",
  "int32_t", "int64_t", "size_t", "intptr_t", "uintptr_t", "bool", "true",
  "false", "NULL", "include", "define", "ifndef", "ifdef", "endif",
  "pragma", "packed", "pragma",
]);

const C_TYPES = new Set([
  "int", "char", "float", "double", "long", "short", "void", "unsigned",
  "signed", "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "int8_t", "int16_t", "int32_t", "int64_t", "intptr_t", "uintptr_t",
  "bool", "FILE", "va_list",
]);

// Shared token regex: comment | string | char | number | word | ws | punct.
// `comment` alternation differs per language, supplied by the caller.
const NUMBER = /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*|'\\[\s\S]'|'\w')\b/;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/;
const WS = /\s+/;

function color(varName: string, text: string, key: number): ReactNode {
  return (
    <span key={key} style={{ color: `rgb(var(--c-${varName}))` }}>
      {text}
    </span>
  );
}

/** Highlight a single line of C / C++ / C-family source. */
function highlightCLine(line: string, lineNo: number): ReactNode[] {
  const out: ReactNode[] = [];
  // Comments: // … and block comments are handled per-line crudely (the
  // generated code uses only line comments, but be safe for pasted files).
  let i = 0;
  let k = lineNo * 100000; // keep keys unique across lines
  while (i < line.length) {
    const rest = line.slice(i);
    // line comment
    if (rest.startsWith("//")) {
      out.push(color("subtle", rest, k++));
      break;
    }
    // block comment start (single-line heuristic)
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end >= 0) {
        out.push(color("subtle", rest.slice(0, end + 2), k++));
        i += end + 2;
        continue;
      }
      out.push(color("subtle", rest, k++));
      break;
    }
    // string
    const strMatch = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    if (strMatch) {
      out.push(color("success", strMatch[0], k++));
      i += strMatch[0].length;
      continue;
    }
    // char literal
    const charMatch = /^'(?:[^'\\]|\\.)*'/.exec(rest);
    if (charMatch) {
      out.push(color("success", charMatch[0], k++));
      i += charMatch[0].length;
      continue;
    }
    // pre-processor directive (#include/#define/…) — whole line if it starts
    // at column 0 with '#'
    if (i === 0 && rest.startsWith("#")) {
      out.push(color("warning", rest, k++));
      break;
    }
    // number
    const numMatch = new RegExp("^" + NUMBER.source).exec(rest);
    if (numMatch) {
      out.push(color("warning", numMatch[0], k++));
      i += numMatch[0].length;
      continue;
    }
    // word
    const wordMatch = WORD.exec(rest);
    if (wordMatch && wordMatch.index === 0) {
      const w = wordMatch[0];
      if (C_KEYWORDS.has(w)) out.push(color("accent", w, k++));
      else if (C_TYPES.has(w)) out.push(color("info", w, k++));
      else if (/^[A-Z][A-Z0-9_]*$/.test(w)) out.push(color("muted", w, k++));
      else out.push(<span key={k++}>{w}</span>);
      i += w.length;
      continue;
    }
    // whitespace
    const wsMatch = WS.exec(rest);
    if (wsMatch && wsMatch.index === 0) {
      out.push(<span key={k++}>{wsMatch[0]}</span>);
      i += wsMatch[0].length;
      continue;
    }
    // punctuation / operators
    out.push(color("subtle", rest[0], k++));
    i += 1;
  }
  return out;
}

/** Highlight a CMakeLists.txt line (commands are case-insensitive). */
function highlightCMakeLine(line: string, lineNo: number): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let k = lineNo * 100000;
  // full-line comment
  if (/^\s*#/.test(line)) {
    return [color("subtle", line, k++)];
  }
  // variable reference ${...} or @VAR@
  while (i < line.length) {
    const rest = line.slice(i);
    const varMatch = /^\$\{[^}]*\}|^@[\w]+@/.exec(rest);
    if (varMatch) {
      out.push(color("info", varMatch[0], k++));
      i += varMatch[0].length;
      continue;
    }
    const strMatch = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    if (strMatch) {
      out.push(color("success", strMatch[0], k++));
      i += strMatch[0].length;
      continue;
    }
    const wsMatch = WS.exec(rest);
    if (wsMatch && wsMatch.index === 0) {
      out.push(<span key={k++}>{wsMatch[0]}</span>);
      i += wsMatch[0].length;
      continue;
    }
    // command name at line start / after whitespace
    const cmdMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (cmdMatch && (i === 0 || /[\s(]/.test(line[i - 1]))) {
      out.push(color("accent", cmdMatch[0], k++));
      i += cmdMatch[0].length;
      continue;
    }
    out.push(color("subtle", rest[0], k++));
    i += 1;
  }
  return out;
}

/** Highlight shell / bash. */
function highlightShLine(line: string, lineNo: number): ReactNode[] {
  const out: ReactNode[] = [];
  let k = lineNo * 100000;
  if (/^\s*#/.test(line)) return [color("subtle", line, k++)];
  // crude: highlight leading command + flags + strings
  const tokens = line.match(/(?:"[^"]*"|'[^']*'|\$\w+|\$\{[^}]*\}|\S+)/g) ?? [];
  let first = true;
  for (const tk of tokens) {
    if (tk.startsWith("#")) {
      out.push(color("subtle", tk, k++));
    } else if (/^["']/.test(tk) || tk.startsWith("$")) {
      out.push(color("success", tk, k++));
    } else if (/^-{1,2}[A-Za-z]/.test(tk)) {
      out.push(color("warning", tk, k++));
    } else if (first) {
      out.push(color("accent", tk, k++));
      first = false;
    } else {
      out.push(<span key={k++}>{tk}</span>);
    }
    out.push(<span key={k++}> </span>);
  }
  return out;
}

function highlightGenericLine(line: string, lineNo: number): ReactNode[] {
  const out: ReactNode[] = [];
  let k = lineNo * 100000;
  if (/^\s*[#;]/.test(line)) return [color("subtle", line, k++)];
  const strMatch = /^"(?:[^"\\]|\\.)*"/.exec(line);
  if (strMatch) {
    return [color("success", line, k++)];
  }
  return [<span key={k++}>{line}</span>];
}

function highlightLine(
  line: string,
  lang: CodeLang,
  lineNo: number,
): ReactNode[] {
  switch (lang) {
    case "c":
    case "cpp":
      return highlightCLine(line, lineNo);
    case "cmake":
      return highlightCMakeLine(line, lineNo);
    case "sh":
      return highlightShLine(line, lineNo);
    case "text":
    default:
      return highlightGenericLine(line, lineNo);
  }
}

export function CodeHighlight({
  code,
  lang = "text",
  className,
}: {
  code: string;
  lang?: CodeLang;
  className?: string;
}) {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  return (
    <pre
      className={
        "overflow-auto whitespace-pre rounded-lg border border-border bg-bg p-3 " +
        "font-mono text-[12px] leading-relaxed text-fg " +
        (className ?? "")
      }
    >
      <code>
        {lines.map((ln, idx) => (
          <span key={idx} className="block">
            {highlightLine(ln, lang, idx)}
            {idx < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** Map a file extension to a highlighter language. */
export function langFromExt(ext: string): CodeLang {
  switch (ext.toLowerCase()) {
    case "c":
    case "h":
    case "cc":
    case "hh":
    case "cxx":
    case "hxx":
    case "cpp":
    case "hpp":
    case "c++":
    case "h++":
    case "ino":
      return "cpp";
    case "cmake":
    case "cmake.in":
      return "cmake";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "sh";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
    case "html":
    case "htm":
      return "xml";
    case "toml":
      return "toml";
    default:
      return "text";
  }
}
