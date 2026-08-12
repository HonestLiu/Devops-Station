import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  LogOut,
  Server,
} from "lucide-react";

import { Button } from "@/components/ui";
import { SftpDualPanel } from "@/components/sftp/SftpDualPanel";
import { ssh } from "@/lib/api";
import { useT } from "@/i18n";
import { cn, hashColor } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import type { Host, SshConnectConfig } from "@/lib/types";

/** Static dual-pane skeleton shown behind the frosted overlay before connect. */
function SftpMockPanel() {
  const t = useT();
  const remote = [
    { name: "deploy", dir: true, size: "—", time: "2d" },
    { name: "logs", dir: true, size: "—", time: "2d" },
    { name: "nginx.conf", dir: false, size: "4.2 KB", time: "2d" },
    { name: "app.log", dir: false, size: "128 KB", time: "1h" },
    { name: "config.yaml", dir: false, size: "812 B", time: "5d" },
  ];
  const local = [
    { name: "Downloads", dir: true, size: "—", time: "3d" },
    { name: "Documents", dir: true, size: "—", time: "3d" },
    { name: "notes.md", dir: false, size: "1.1 KB", time: "3h" },
    { name: "backup.zip", dir: false, size: "48 MB", time: "yesterday" },
  ];

  const renderRow = (f: { name: string; dir: boolean; size: string; time: string }, i: number) => (
    <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      {f.dir ? (
        <Folder size={15} className="shrink-0 text-accent" />
      ) : (
        <FileIcon size={15} className="shrink-0 text-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-fg/70">{f.name}</span>
      <span className="w-14 shrink-0 text-right text-[11px] text-muted/60">{f.size}</span>
      <span className="w-20 shrink-0 text-right text-[11px] text-subtle/60">{f.time}</span>
    </div>
  );

  const pane = (
    side: "remote" | "local",
    path: string,
    rows: typeof remote,
  ) => (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-bg/40">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 bg-bg/40 px-2">
        {side === "remote" ? (
          <Server size={13} className="text-accent" />
        ) : (
          <HardDrive size={13} className="text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate rounded-md bg-bg px-2 py-1 font-mono text-[11px] text-muted">
          {path}
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider",
            side === "remote" ? "bg-accent/15 text-accent" : "bg-hover text-muted",
          )}
        >
          {side === "remote" ? t("sftp.remote") : t("sftp.local")}
        </span>
      </div>
      <div className="flex-1 space-y-0.5 overflow-hidden p-1.5">
        {rows.map(renderRow)}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-2 bg-surface p-2">
      <div className="flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-border/50 bg-bg/40 text-[11px] text-subtle/70">
        <FolderOpen size={13} className="text-accent/60" />
        {t("sftp.connectHint")}
      </div>
      <div className="flex min-h-0 flex-1 gap-2">
        {pane("remote", "/home/admin", remote)}
        {pane("local", "C:\\Users\\Hones", local)}
      </div>
    </div>
  );
}

export function SftpPage() {
  const t = useT();
  const setPage = useAppStore((s) => s.setPage);
  const hosts = useHostsStore((s) => s.hosts);
  const sshHosts = useMemo(() => hosts.filter((h) => h.kind === "ssh"), [hosts]);

  const [host, setHost] = useState<Host | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const connectTo = async (h: Host) => {
    setHost(h);
    setStatus("connecting");
    setError(undefined);
    const config: SshConnectConfig = {
      hostId: h.id,
      hostname: h.hostname ?? "",
      port: h.port ?? 22,
      username: h.username ?? "",
      // Sentinel — the backend swaps it for the decrypted secret.
      password: h.password ?? undefined,
      privateKeyPath: h.privateKeyPath ?? undefined,
      passphrase: h.passphrase ?? undefined,
      cols: 120,
      rows: 32,
      term: "xterm-256color",
    };
    try {
      const res = await ssh.connect(config);
      setSessionId(res.sessionId);
      setStatus("connected");
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    }
  };

  const disconnect = async () => {
    if (sessionId) void ssh.disconnect(sessionId).catch(() => undefined);
    setSessionId(undefined);
    setStatus("idle");
    setHost(null);
    setError(undefined);
  };

  // Tear down the session when leaving the page.
  useEffect(() => {
    return () => {
      if (sessionId) void ssh.disconnect(sessionId).catch(() => undefined);
    };
  }, [sessionId]);

  return (
    <div className="relative flex h-full flex-col">
      {status === "connected" && host && sessionId && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-surface px-3">
          <div className="flex min-w-0 items-center gap-2 text-[12px]">
            <FolderOpen size={13} className="shrink-0 text-accent" />
            <span className="truncate font-medium text-fg">{host.name}</span>
            <span className="truncate text-subtle">
              {host.username ? `${host.username}@` : ""}
              {host.hostname}:{host.port ?? 22}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void disconnect()} title={t("sftp.disconnect")}>
            <LogOut size={13} /> {t("sftp.disconnect")}
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {status === "connected" && sessionId ? (
          <SftpDualPanel key={sessionId} sessionId={sessionId} />
        ) : (
          <SftpMockPanel />
        )}

        {/* Frosted overlay + centered host picker while not connected */}
        {status !== "connected" && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/55 p-6 backdrop-blur-md">
            <div className="card w-[460px] max-w-full p-0 shadow-2xl">
              <div className="border-b border-border/70 px-5 py-4">
                <h2 className="text-[15px] font-semibold text-fg">{t("sftp.connectVia")}</h2>
                <p className="mt-0.5 text-[12px] text-muted">
                  {t("sftp.pickHost")}
                </p>
              </div>

              <div className="p-3">
                {status === "connecting" ? (
                  <div className="flex flex-col items-center gap-3 py-10">
                    <Loader2 size={24} className="animate-spin text-accent" />
                    <p className="text-[13px] text-muted">{t("sftp.connecting", { name: host?.name ?? "" })}</p>
                  </div>
                ) : status === "error" ? (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <AlertTriangle size={24} className="text-danger" />
                    <p className="text-[13px] font-medium text-fg">{t("sftp.connectionFailed")}</p>
                    <p className="max-w-sm break-words text-[12px] text-muted">{error}</p>
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setStatus("idle")}>
                        {t("sftp.chooseAnother")}
                      </Button>
                      {host && (
                        <Button variant="primary" size="sm" onClick={() => void connectTo(host)}>
                          {t("common.retry")}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : sshHosts.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <Server size={26} className="text-subtle" />
                    <p className="text-[13px] text-muted">{t("sftp.noHosts")}</p>
                    <Button variant="primary" size="sm" onClick={() => setPage("hosts")}>
                      {t("sftp.goToHosts")}
                    </Button>
                  </div>
                ) : (
                  <div className="max-h-[46vh] space-y-0.5 overflow-y-auto">
                    {sshHosts.map((h) => {
                      const color = h.color || hashColor(h.name);
                      return (
                        <button
                          key={h.id}
                          onClick={() => void connectTo(h)}
                          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold text-accent-fg"
                            style={{ backgroundColor: color }}
                          >
                            {h.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-fg">
                              {h.name}
                            </span>
                            <span className="block truncate text-[11px] text-subtle">
                              {h.username ? `${h.username}@` : ""}
                              {h.hostname}
                              {h.port ? `:${h.port}` : ""}
                            </span>
                          </span>
                          <ChevronRight size={15} className="shrink-0 text-subtle" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
