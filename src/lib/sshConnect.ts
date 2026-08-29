import { ssh } from "@/lib/api";
import { useHostKeyStore } from "@/store/useHostKeyStore";
import type { SshConnectConfig, SshConnectResult } from "@/lib/types";

/**
 * Connect to an SSH host, prompting the user to trust an unknown/changed key.
 *
 * Lives outside the tabs store so any surface that needs a one-off session
 * (e.g. the SFTP panel's optional second host) can reuse the same flow.
 */
export async function connectSshWithHostKeyPrompt(
  config: SshConnectConfig,
): Promise<SshConnectResult> {
  try {
    return await ssh.connect(config);
  } catch (err) {
    const msg = (err as Error).message;
    const m = /HOST_KEY_(UNKNOWN|MISMATCH)\|([^|]+)\|(\d+)\|(.+)$/.exec(msg);
    if (!m) throw err;
    const [, kind, host, portStr, fp] = m;
    const trust = await useHostKeyStore.getState().request({
      host,
      port: Number(portStr),
      fingerprint: fp,
      mismatch: kind === "MISMATCH",
    });
    if (!trust) throw err;
    return await ssh.connect({ ...config, trustHostKey: true });
  }
}
