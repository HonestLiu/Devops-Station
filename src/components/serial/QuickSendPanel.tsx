import { useRef, useState } from "react";
import { Plus, Play, Repeat, Square, Trash2 } from "lucide-react";

import { Button, Input, Checkbox } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface QuickSendItem {
  id: string;
  enabled: boolean;
  content: string;
  note?: string;
  hex: boolean;
  delayMs: number;
}

interface QuickSendPanelProps {
  connected: boolean;
  onSend: (raw: string, asHex: boolean) => void;
}

function nextId() {
  return `qs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function QuickSendPanel({ connected, onSend }: QuickSendPanelProps) {
  const [items, setItems] = useState<QuickSendItem[]>([
    { id: nextId(), enabled: true, content: "AT+RST", note: "重启模块", hex: false, delayMs: 1000 },
    { id: nextId(), enabled: true, content: "AT+GMR", note: "查询版本信息", hex: false, delayMs: 1000 },
  ]);
  const [loopMs, setLoopMs] = useState(5000);
  const [looping, setLooping] = useState(false);
  const abortRef = useRef(false);

  const updateItem = (id: string, patch: Partial<QuickSendItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { id: nextId(), enabled: true, content: "", note: "", hex: false, delayMs: 1000 },
    ]);
  };

  const activeItems = items.filter((it) => it.enabled && it.content.trim() !== "");

  const sendOne = (it: QuickSendItem) => {
    if (!connected || !it.content.trim()) return;
    onSend(it.content.trim(), it.hex);
  };

  const sendSelected = () => {
    if (!connected || activeItems.length === 0) return;
    for (const it of activeItems) {
      sendOne(it);
    }
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const toggleLoop = async () => {
    if (looping) {
      abortRef.current = true;
      setLooping(false);
      return;
    }
    if (!connected || activeItems.length === 0) return;
    abortRef.current = false;
    setLooping(true);
    try {
      while (!abortRef.current) {
        for (const it of activeItems) {
          if (abortRef.current) break;
          sendOne(it);
          if (it.delayMs > 0) await sleep(it.delayMs);
        }
        if (loopMs > 0 && !abortRef.current) await sleep(loopMs);
      }
    } finally {
      setLooping(false);
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-[12px] font-semibold text-fg">快捷输入面板</span>
        <Button variant="ghost" size="sm" onClick={addItem} disabled={!connected} title="添加一行">
          <Plus size={14} />
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          onClick={sendSelected}
          disabled={!connected || activeItems.length === 0}
        >
          <Play size={13} /> 发送选中
        </Button>
        <Button
          variant={looping ? "danger" : "secondary"}
          size="sm"
          className="flex-1"
          onClick={toggleLoop}
          disabled={!connected || activeItems.length === 0}
        >
          {looping ? <Square size={13} /> : <Repeat size={13} />}
          {looping ? "停止循环" : "循环发送"}
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] text-subtle">循环间隔</span>
        <Input
          type="number"
          min={0}
          step={100}
          value={loopMs}
          onChange={(e) => setLoopMs(Math.max(0, Number(e.target.value)))}
          className="h-7 w-20 px-1.5 text-center text-[12px]"
        />
        <span className="text-[11px] text-subtle">ms</span>
      </div>

      <div className="grid grid-cols-[32px_1fr_40px_56px_64px] gap-1 border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-subtle">
        <span>启用</span>
        <span>内容</span>
        <span className="text-center">HEX</span>
        <span className="text-center">延时</span>
        <span className="text-center">操作</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && (
          <div className="p-4 text-center text-[11px] text-subtle">点击 + 添加快捷发送命令</div>
        )}
        {items.map((it, idx) => (
          <div
            key={it.id}
            className={cn(
              "grid grid-cols-[32px_1fr_40px_56px_64px] items-center gap-1 border-b border-border/50 px-3 py-1",
              it.enabled && "bg-accent/5",
            )}
          >
            <div className="flex justify-center">
              <input
                type="checkbox"
                checked={it.enabled}
                onChange={(e) => updateItem(it.id, { enabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <Input
                value={it.content}
                onChange={(e) => updateItem(it.id, { content: e.target.value })}
                placeholder={it.hex ? "01 02 03" : "AT+CMD"}
                className="h-7 text-[12px]"
                disabled={!connected}
              />
              <Input
                value={it.note ?? ""}
                onChange={(e) => updateItem(it.id, { note: e.target.value })}
                placeholder="备注"
                className="h-6 border-0 bg-transparent px-0 text-[10px] text-subtle placeholder:text-subtle/60 focus:ring-0"
              />
            </div>
            <div className="flex justify-center">
              <input
                type="checkbox"
                checked={it.hex}
                onChange={(e) => updateItem(it.id, { hex: e.target.checked })}
                className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
              />
            </div>
            <Input
              type="number"
              min={0}
              step={50}
              value={it.delayMs}
              onChange={(e) => updateItem(it.id, { delayMs: Math.max(0, Number(e.target.value)) })}
              className="h-7 px-1 text-center text-[11px]"
            />
            <div className="flex items-center justify-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => sendOne(it)}
                disabled={!connected || !it.content.trim()}
                title="发送"
              >
                <Play size={12} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-danger"
                onClick={() => removeItem(it.id)}
                title="删除"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
