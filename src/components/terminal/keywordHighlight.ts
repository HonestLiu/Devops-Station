import type { Terminal as XTerm, IMarker, IDecoration } from "@xterm/xterm";

import type { KeywordHighlightRule } from "@/lib/types";

interface CompiledRule {
  regex: RegExp;
  color: string;
  wholeLine: boolean;
}

interface Tracked {
  deco: IDecoration;
  marker: IMarker;
}

const MAX_DECORATIONS = 600;
/** Only the most recent N lines are scanned, bounding work on huge scrollbacks. */
const SCAN_TAIL = 4000;
const SCAN_BUDGET_MS = 16;

function compile(rules: KeywordHighlightRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue;
    try {
      out.push({
        regex: new RegExp(r.pattern, "i"),
        color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#ff5555",
        wholeLine: !!r.wholeLine,
      });
    } catch {
      // Invalid user regex — ignore at the render boundary.
    }
  }
  return out;
}

/**
 * Line-level keyword highlighter. Wraps `term.write` so new output triggers a
 * debounced re-scan; matched lines get a whole-line background tint (when the
 * rule asks for it) plus a scrollbar overview marker. Uses xterm's public
 * `Decoration` API, so it is stable across xterm versions (no internal-cell
 * mutation). Per-host rules are merged with the global rules by the caller.
 */
export class KeywordHighlighter {
  private compiled: CompiledRule[] = [];
  private enabled = false;
  private tracked: Tracked[] = [];
  private timer: number | null = null;
  private disposed = false;
  private scanStart = 0;
  private readonly originalWrite: XTerm["write"];
  private readonly originalClear: XTerm["clear"];
  private readonly originalReset: XTerm["reset"];
  private readonly disposables: { dispose: () => void }[] = [];

  constructor(private readonly term: XTerm) {
    this.originalWrite = term.write.bind(term);
    this.originalClear = term.clear.bind(term);
    this.originalReset = term.reset.bind(term);
    term.write = (data, cb) =>
      this.originalWrite(data, () => {
        cb?.();
        this.schedule();
      });
    term.clear = () => {
      const r = this.originalClear();
      this.clearDecorations();
      return r;
    };
    term.reset = () => {
      const r = this.originalReset();
      this.clearDecorations();
      return r;
    };
    this.disposables.push(
      term.onScroll(() => this.schedule()),
      term.onResize(() => this.schedule()),
    );
  }

  setRules(enabled: boolean, rules: KeywordHighlightRule[]): void {
    if (this.disposed) return;
    this.enabled = enabled;
    this.compiled = compile(rules);
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, 120);
  }

  private clearDecorations(): void {
    for (const t of this.tracked) {
      try {
        t.deco.dispose();
      } catch {
        /* already gone */
      }
      try {
        t.marker.dispose();
      } catch {
        /* already gone */
      }
    }
    this.tracked = [];
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    this.clearDecorations();
    if (!this.enabled || this.compiled.length === 0) return;
    const buf = this.term.buffer.active;
    const total = buf.length;
    const cursor = buf.baseY + buf.cursorY;
    const start = Math.max(0, total - SCAN_TAIL);
    const startedAt = performance.now();
    for (let y = start; y < total; y += 1) {
      if (this.tracked.length >= MAX_DECORATIONS) break;
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(false);
      if (!text) continue;
      let matched: CompiledRule | null = null;
      for (const rule of this.compiled) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(text)) {
          matched = rule;
          break;
        }
      }
      if (!matched) continue;
      const marker = this.term.registerMarker(y - cursor);
      if (!marker) continue;
      const deco = this.term.registerDecoration({
        marker,
        backgroundColor: matched.wholeLine ? matched.color : undefined,
        overviewRulerOptions: { color: matched.color, position: "full" },
      });
      if (!deco) {
        marker.dispose();
        continue;
      }
      this.tracked.push({ deco, marker });
      // Yield periodically so a flood of output can't freeze the UI.
      if (this.tracked.length % 64 === 0 && performance.now() - startedAt > SCAN_BUDGET_MS) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearDecorations();
    for (const d of this.disposables) d.dispose();
    this.term.write = this.originalWrite;
    this.term.clear = this.originalClear;
    this.term.reset = this.originalReset;
  }
}
