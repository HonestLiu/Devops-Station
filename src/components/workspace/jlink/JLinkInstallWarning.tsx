import { useT } from "@/i18n";
import { useJlinkStore } from "@/store/useJlinkStore";

/** Footer warning shown by every J-Link module when the SEGGER software is
 *  not installed. */
export function JLinkInstallWarning() {
  const t = useT();
  const available = useJlinkStore((s) => s.available);
  if (available !== false) return null;
  return (
    <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[12px] text-warning">
      {t("jlink.installWarning", {
        pack: "J-Link Software and Documentation Pack",
        dir: "C:\\Program Files (x86)\\SEGGER\\JLink",
      })}
    </p>
  );
}
