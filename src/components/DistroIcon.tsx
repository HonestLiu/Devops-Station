import ubuntu from "@/assets/distro/ubuntu.svg?url";
import debian from "@/assets/distro/debian.svg?url";
import centos from "@/assets/distro/centos.svg?url";
import fedora from "@/assets/distro/fedora.svg?url";
import arch from "@/assets/distro/arch.svg?url";
import alpine from "@/assets/distro/alpine.svg?url";
import amazon from "@/assets/distro/amazon.svg?url";
import redhat from "@/assets/distro/redhat.svg?url";
import rocky from "@/assets/distro/rocky.svg?url";
import opensuse from "@/assets/distro/opensuse.svg?url";
import oracle from "@/assets/distro/oracle.svg?url";
import kali from "@/assets/distro/kali.svg?url";
import almalinux from "@/assets/distro/almalinux.svg?url";
import linux from "@/assets/distro/linux.svg?url";
import type { DistroId } from "@/lib/types";

interface DistroMeta {
  label: string;
  /** URL of the distribution logo SVG (see `src/assets/distro`). */
  url: string;
}

/** Known distributions, each with its brand logo (mirrors `DistroId`). */
export const DISTROS: Record<DistroId, DistroMeta> = {
  ubuntu: { label: "Ubuntu", url: ubuntu },
  debian: { label: "Debian", url: debian },
  centos: { label: "CentOS", url: centos },
  fedora: { label: "Fedora", url: fedora },
  arch: { label: "Arch Linux", url: arch },
  alpine: { label: "Alpine", url: alpine },
  amazon: { label: "Amazon Linux", url: amazon },
  redhat: { label: "Red Hat", url: redhat },
  rocky: { label: "Rocky Linux", url: rocky },
  opensuse: { label: "openSUSE", url: opensuse },
  oracle: { label: "Oracle Linux", url: oracle },
  kali: { label: "Kali Linux", url: kali },
  almalinux: { label: "AlmaLinux", url: almalinux },
  linux: { label: "Linux", url: linux },
};

export const DISTRO_LIST = Object.keys(DISTROS) as DistroId[];

/**
 * Resolve a distro id to a known `DistroId` (best effort).
 * Accepts either a plain id (e.g. "ubuntu"), full `os-release` content
 * (`ID=` / `ID_LIKE=`), or a `uname` string. Returns null only for empty input.
 */
export function normalizeDistro(input?: string | null): DistroId | null {
  if (!input) return null;

  // Pull `ID=` and `ID_LIKE=` out of os-release style content when present.
  const ids: string[] = [];
  if (/^\s*ID=/.test(input) || input.includes("ID_LIKE=")) {
    const grab = (key: string): string[] =>
      input
        .split("\n")
        .find((l) => l.trimStart().startsWith(key + "="))
        ?.split("=")[1]
        ?.replace(/["'\r]/g, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean) ?? [];
    ids.push(...grab("ID"), ...grab("ID_LIKE"));
  } else {
    ids.push(input.trim().toLowerCase());
  }

  for (const id of ids) {
    if (id.includes("ubuntu")) return "ubuntu";
    if (id.includes("debian") || id.includes("raspbian")) return "debian";
    if (id.includes("centos")) return "centos";
    if (id.includes("fedora")) return "fedora";
    if (id.includes("arch")) return "arch";
    if (id.includes("alpine")) return "alpine";
    if (id.includes("amzn") || id.includes("amazon")) return "amazon";
    if (id.includes("rocky")) return "rocky";
    if (id.includes("opensuse") || id.includes("suse")) return "opensuse";
    if (id === "ol" || id.includes("oracle")) return "oracle"; // Oracle Linux: ID=ol
    if (id.includes("kali")) return "kali";
    if (id.includes("alma")) return "almalinux";
    if (id.includes("rhel") || id.includes("redhat") || id.includes("red hat")) return "redhat";
  }
  return "linux";
}

export function DistroIcon({
  distro,
  size = 18,
  className,
}: {
  distro?: string | null;
  size?: number;
  className?: string;
}) {
  const meta = distro ? DISTROS[distro as DistroId] : undefined;
  const data = meta ?? DISTROS.linux;
  return (
    <img
      src={data.url}
      width={size}
      height={size}
      alt={data.label}
      title={meta ? meta.label : "Linux"}
      draggable={false}
      className={`inline-block shrink-0 rounded-sm object-contain ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}
