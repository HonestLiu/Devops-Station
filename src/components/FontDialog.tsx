import { Dialog } from "@/components/ui";
import { FontPicker } from "./FontPicker";
import { useAppStore } from "@/store/useAppStore";

/**
 * Modal wrapper around the terminal font picker. Kept out of the Settings
 * page itself so the (tall, scrollable) font catalog doesn't bloat the form.
 */
export function FontDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const fontFamily = useAppStore((s) => s.settings.fontFamily);
  const importedFonts = useAppStore((s) => s.settings.importedFonts);
  const updateSetting = useAppStore((s) => s.updateSetting);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Terminal Font"
      description="Pick fonts in priority order, or import your own. Changes apply instantly."
      width="max-w-2xl"
    >
      <FontPicker
        value={fontFamily}
        onChange={(v) => void updateSetting("fontFamily", v)}
        importedFonts={importedFonts}
        onImportedFontsChange={(v) => void updateSetting("importedFonts", v)}
      />
    </Dialog>
  );
}
