import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, ListTree, RefreshCw } from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { wsl } from "@/lib/api";
import type { WslDistro } from "@/lib/types";

/** Sentinel option value that switches the picker into free-text mode. */
const CUSTOM = "__custom__";

/** Minimum spinner duration for a manual refresh, so the click registers visually. */
const SPIN_MS = 350;

/** WSL reports state in the host language; match the English ones we know. */
function isRunning(state: string): boolean {
  return state.toLowerCase() === "running";
}

function sameList(a: WslDistro[], b: WslDistro[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (d, i) =>
      d.name === b[i].name && d.state === b[i].state && d.isDefault === b[i].isDefault,
  );
}

/**
 * WSL distribution selector backed by `wsl -l -v`.
 *
 * Unlike the serial picker this does **not** poll: every scan spawns a real
 * `wsl.exe` process, and the installed-distro list is effectively static while
 * a dialog is open. Instead it scans on mount, on manual refresh, and when the
 * window regains focus — which covers "I just installed a distro in another
 * window" without burning a process every couple of seconds.
 *
 * An empty value is a first-class choice meaning "whatever WSL considers the
 * default", so this field never blocks saving.
 */
export function DistroPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (distro: string) => void;
}) {
  const [distros, setDistros] = useState<WslDistro[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [manual, setManual] = useState(false);

  const scan = useCallback(async (spin = false) => {
    const startedAt = Date.now();
    if (spin) setScanning(true);
    try {
      const list = await wsl.listDistros();
      setDistros((prev) => (sameList(prev, list) ? prev : list));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanned(true);
      if (spin) {
        const remaining = SPIN_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        setScanning(false);
      }
    }
  }, []);

  // Keep the focus handler stable so it isn't re-bound on every render.
  const scanRef = useRef(scan);
  scanRef.current = scan;

  useEffect(() => {
    void scan(true);
    const onFocus = () => void scanRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scan]);

  const trimmed = value.trim();
  const selected = distros.find((d) => d.name === value);
  /** A saved distro that is no longer installed (renamed, unregistered…). */
  const missing = trimmed !== "" && !selected && scanned && !error;
  const fallback = distros.find((d) => d.isDefault);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setManual(true);
      return;
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {manual ? (
          <>
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Ubuntu-22.04"
              className="select-text font-mono"
              autoFocus
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8 shrink-0 px-2"
              onClick={() => {
                setManual(false);
                void scan(true);
              }}
              title="Back to detected distros"
              aria-label="Back to detected distros"
            >
              <ListTree size={13} />
            </Button>
          </>
        ) : (
          <>
            <Select
              value={missing ? value : selected?.name ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
              className="font-mono"
            >
              {/* Empty is a real choice here, not a "nothing picked" placeholder. */}
              <option value="">
                {!scanned
                  ? "Scanning…"
                  : fallback
                    ? `Default (${fallback.name})`
                    : "Default distro"}
              </option>
              {/* Keep a saved-but-uninstalled distro selectable so editing can't drop it. */}
              {missing && <option value={value}>{value} · not installed</option>}
              {distros.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                  {d.isDefault ? " · default" : ""}
                </option>
              ))}
              <option value={CUSTOM}>Enter manually…</option>
            </Select>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 shrink-0 px-2"
              onClick={() => void scan(true)}
              disabled={scanning}
              title={scanned ? `Rescan distros (${distros.length} found)` : "Rescan distros"}
              aria-label="Rescan WSL distributions"
            >
              <RefreshCw size={13} className={scanning ? "animate-spin" : undefined} />
            </Button>
          </>
        )}
      </div>

      <DistroStatus
        error={error}
        manual={manual}
        missing={missing}
        scanned={scanned}
        selected={selected}
        fallback={fallback}
        count={distros.length}
      />
    </div>
  );
}

function DistroStatus({
  error,
  manual,
  missing,
  scanned,
  selected,
  fallback,
  count,
}: {
  error?: string;
  manual: boolean;
  missing: boolean;
  scanned: boolean;
  selected?: WslDistro;
  fallback?: WslDistro;
  count: number;
}) {
  if (error) {
    return <span className="text-[11px] text-danger">{error}</span>;
  }
  if (manual) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-subtle">
        <Keyboard size={11} />
        Manual entry — {count > 0 ? `${count} distro${count > 1 ? "s" : ""} installed` : "none detected"}
      </span>
    );
  }
  if (missing) {
    return (
      <span className="text-[11px] text-warning">
        This distro is not installed right now — connecting will fail until it is back.
      </span>
    );
  }
  const shown = selected ?? fallback;
  if (shown) {
    return (
      <span className="text-[11px] text-subtle">
        WSL {shown.version} · {shown.state}
        {isRunning(shown.state) ? "" : " — it will start on connect."}
      </span>
    );
  }
  if (!scanned) {
    return <span className="text-[11px] text-subtle">Looking for WSL distributions…</span>;
  }
  return (
    <span className="text-[11px] text-subtle">
      No distributions installed — run <code className="font-mono">wsl --install -d Ubuntu</code>.
    </span>
  );
}
