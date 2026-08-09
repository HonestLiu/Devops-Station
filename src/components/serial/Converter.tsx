import { useState } from "react";

import { Button, Field, Select } from "@/components/ui";
import {
  bytesToAscii,
  bytesToBinary,
  bytesToDecimal,
  bytesToHex,
  hexToBytes,
} from "@/lib/utils";

/**
 * Bidirectional byte inspector: type text or hex and see all four common
 * representations side by side. Essential when debugging a serial protocol.
 */
export function Converter() {
  const [mode, setMode] = useState<"text" | "hex">("text");
  const [input, setInput] = useState("");

  let bytes: Uint8Array;
  try {
    bytes = mode === "hex" ? hexToBytes(input) : new TextEncoder().encode(input);
  } catch {
    bytes = new Uint8Array();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Field label="Input format">
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as "text" | "hex")}
            className="w-28"
          >
            <option value="text">Text</option>
            <option value="hex">Hex</option>
          </Select>
        </Field>
        <Button variant="ghost" size="sm" className="mt-5" onClick={() => setInput("")}>
          Clear
        </Button>
      </div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={2}
        placeholder={mode === "hex" ? "AA BB 0C" : "hello"}
        className="select-text w-full resize-none rounded border border-border bg-bg p-2 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
      />
      <div className="grid grid-cols-1 gap-2">
        {([
          ["ASCII", bytesToAscii(bytes)],
          ["HEX", bytesToHex(bytes)],
          ["BIN", bytesToBinary(bytes)],
          ["DEC", bytesToDecimal(bytes)],
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded border border-border bg-bg p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-subtle">{label}</div>
            <code className="block break-all font-mono text-[11px] text-fg">
              {value || "—"}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
