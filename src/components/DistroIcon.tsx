import type { DistroId } from "@/lib/types";

interface DistroMeta {
  label: string;
  /** Brand color used for the badge background. */
  color: string;
  /** 1–2 char short code shown inside the badge. */
  short: string;
}

/** Known distributions, mirroring Netcatty's distro icon set. */
export const DISTROS: Record<DistroId, DistroMeta> = {
  ubuntu: { label: "Ubuntu", color: "#E95420", short: "U" },
  debian: { label: "Debian", color: "#A80030", short: "D" },
  centos: { label: "CentOS", color: "#932279", short: "C" },
  fedora: { label: "Fedora", color: "#3C6EB4", short: "F" },
  arch: { label: "Arch Linux", color: "#1793D1", short: "A" },
  alpine: { label: "Alpine", color: "#0D597F", short: "Al" },
  amazon: { label: "Amazon Linux", color: "#232F3E", short: "Am" },
  redhat: { label: "Red Hat", color: "#EE0000", short: "R" },
  rocky: { label: "Rocky Linux", color: "#10B981", short: "Ro" },
  opensuse: { label: "openSUSE", color: "#73BA25", short: "Su" },
  oracle: { label: "Oracle Linux", color: "#F80000", short: "O" },
  kali: { label: "Kali Linux", color: "#557C2E", short: "K" },
  almalinux: { label: "AlmaLinux", color: "#5194D8", short: "Al" },
  rhel: { label: "RHEL", color: "#EE0000", short: "R" },
  linux: { label: "Linux", color: "#6b7280", short: "Lx" },
};

export const DISTRO_LIST = Object.keys(DISTROS) as DistroId[];

/** Resolve a free-form os-release ID= value to a known distro id (best effort). */
export function normalizeDistro(input?: string | null): DistroId | null {
  if (!input) return null;
  const id = input.trim().toLowerCase();
  if ((DISTROS as Record<string, DistroMeta>)[id]) return id as DistroId;
  if (id.includes("ubuntu")) return "ubuntu";
  if (id.includes("debian")) return "debian";
  if (id.includes("centos")) return "centos";
  if (id.includes("fedora")) return "fedora";
  if (id.includes("arch")) return "arch";
  if (id.includes("alpine")) return "alpine";
  if (id.includes("amzn") || id.includes("amazon")) return "amazon";
  if (id.includes("rocky")) return "rocky";
  if (id.includes("opensuse") || id.includes("suse")) return "opensuse";
  if (id.includes("oracle")) return "oracle";
  if (id.includes("kali")) return "kali";
  if (id.includes("alma")) return "almalinux";
  if (id.includes("rhel") || id.includes("red hat") || id.includes("redhat")) return "redhat";
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
  if (!meta) {
    // Generic Linux badge (grey) so unset hosts still get a consistent chip.
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-bold text-fg ${className ?? ""}`}
        style={{ width: size, height: size }}
        title="Linux"
      >
        Lx
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white ${className ?? ""}`}
      style={{ width: size, height: size, background: meta.color }}
      title={meta.label}
    >
      {meta.short}
    </span>
  );
}
