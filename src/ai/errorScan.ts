/**
 * Lightweight terminal error detection used to surface a *dismissible* inline
 * "let AI fix it?" hint (see useAiSuggestion + TerminalInlineAsk).
 *
 * This is intentionally conservative: it only matches high-signal, unambiguous
 * error patterns so we never nag the operator the way the old notification path
 * did. The scan runs on a small buffered tail of decoded output, so it stays
 * cheap even on a busy terminal.
 */

const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

interface Rule {
  re: RegExp;
  label: string;
}

// Ordered: more specific first so "command not found" wins over a generic match.
const RULES: Rule[] = [
  { re: /(?:bash|sh|zsh|fish):\s+\S+:\s+command not found/i, label: "Command not found" },
  { re: /command not found/i, label: "Command not found" },
  { re: /\bpermission denied\b/i, label: "Permission denied" },
  { re: /no such file or directory/i, label: "File not found" },
  { re: /(?:connection|connect) refused/i, label: "Connection refused" },
  { re: /no route to host/i, label: "No route to host" },
  { re: /(?:connection )?timed out/i, label: "Connection timed out" },
  { re: /could not resolve|name or service not known|unknown host/i, label: "DNS / host lookup failed" },
  { re: /\bEACCES\b|\bEPERM\b/i, label: "Permission error (EACCES/EPERM)" },
  { re: /\bEADDRINUSE\b/i, label: "Port already in use" },
  { re: /\bENOENT\b/i, label: "File not found (ENOENT)" },
  { re: /\bEAI_AGAIN\b/i, label: "Temporary DNS failure" },
  { re: /\bfatal error\b|\bFATAL\b/i, label: "Fatal error" },
  { re: /\[ERROR\]/i, label: "Error" },
  { re: /^\s*\S*error:\s*.+$/im, label: "Error" },
  { re: /segmentation fault/i, label: "Segmentation fault" },
  { re: /core dumped/i, label: "Process crashed (core dumped)" },
  { re: /\bpanic:/i, label: "Panic" },
  { re: /(?:build|task|job|make|step).*\bFAILED\b/i, label: "Build / job failed" },
  { re: /(?:failed|unable) to (?:connect|listen|bind)/i, label: "Connect / bind failed" },
  { re: /\b(404|410)\b.*not found/i, label: "HTTP 404" },
  { re: /\b(500|502|503|504)\b/, label: "HTTP server error" },
];

export interface ErrorHit {
  label: string;
  snippet: string;
}

/**
 * Scan a chunk of terminal text for a high-signal error. Returns the first
 * matching line (trimmed, capped) with a short human label, or null.
 */
export function scanForError(text: string): ErrorHit | null {
  const clean = stripAnsi(text);
  // Only inspect the tail — errors appear at the end of the stream and this
  // keeps the per-chunk cost bounded.
  const tail = clean.length > 800 ? clean.slice(-800) : clean;
  const lines = tail.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    for (const { re, label } of RULES) {
      if (re.test(line)) {
        return { label, snippet: line.slice(0, 200) };
      }
    }
  }
  return null;
}
