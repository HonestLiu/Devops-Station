import { useState } from "react";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";

import { Badge, Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { injectCommandLines, writeRawBytes } from "@/ai/terminalAi";
import { useHostsStore } from "@/store/useHostsStore";
import type { QuickCommand } from "@/lib/types";

const SCOPES: QuickCommand["scope"][] = ["ssh", "serial", "both"];

export function QuickCommandsEditor({ onClose }: { onClose: () => void }) {
  const commands = useHostsStore((s) => s.quickCommands);
  const save = useHostsStore((s) => s.saveQuickCommand);
  const remove = useHostsStore((s) => s.deleteQuickCommand);

  const [draft, setDraft] = useState<QuickCommand | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<QuickCommand["scope"]>("both");
  const [isHex, setIsHex] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const resetForm = () => {
    setDraft(null);
    setName("");
    setValue("");
    setScope("both");
    setIsHex(false);
    setEditingId(null);
  };

  const startEdit = (c: QuickCommand) => {
    setEditingId(c.id);
    setDraft(c);
    setName(c.name);
    setValue(c.value);
    setScope(c.scope);
    setIsHex(c.isHex);
  };

  const submit = async () => {
    if (!name.trim() || !value.trim()) return;
    const next: QuickCommand = {
      id: editingId ?? crypto.randomUUID(),
      name: name.trim(),
      value: value.trim(),
      scope,
      isHex,
      sortOrder: draft?.sortOrder ?? commands.length,
    };
    await save(next);
    resetForm();
  };

  /** One-click insert into the active terminal (text runs with Enter; hex sends raw bytes). */
  const send = (c: QuickCommand) => {
    if (c.isHex) {
      const hex = c.value.replace(/\s+/g, "");
      if (hex.length % 2 !== 0) return;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      writeRawBytes(bytes);
    } else {
      void injectCommandLines(c.value, true);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Quick Commands"
      description="Reusable snippets sent to the terminal or serial port with one click."
      width="max-w-2xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {/* Editor */}
      <div className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-border bg-bg p-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Reboot"
            className="select-text"
          />
        </Field>
        <Field label="Scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value as QuickCommand["scope"])}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Value" className="sm:col-span-2" hint='Use \r \n \t for control chars. Hex mode sends raw bytes.'>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="systemctl restart myapp"
            className="select-text font-mono text-[12px]"
          />
        </Field>
        <div className="flex items-center gap-4 sm:col-span-2">
          <Checkbox label="Send as hex bytes" checked={isHex} onChange={setIsHex} />
          <Button variant="primary" size="sm" onClick={() => void submit()}>
            <Plus size={13} /> {editingId ? "Update" : "Add"}
          </Button>
          {editingId && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="space-y-1.5">
        {commands.length === 0 && (
          <p className="py-6 text-center text-[12px] text-subtle">No quick commands yet.</p>
        )}
        {commands.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-fg">{c.name}</span>
                <Badge tone={c.scope === "both" ? "neutral" : "accent"}>{c.scope}</Badge>
                {c.isHex && <Badge tone="warning">HEX</Badge>}
              </div>
              <code className="block truncate text-[11px] text-subtle">{c.value}</code>
            </div>
            <Button variant="ghost" size="sm" onClick={() => send(c)} title="Send to terminal">
              <Play size={13} className="text-accent" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => startEdit(c)} title="Edit">
              <Pencil size={13} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void remove(c.id)}
              title="Delete"
            >
              <Trash2 size={13} className="text-danger" />
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
