import { fonts } from "@/lib/api";

/** Decode a base64 string into a byte array (for the `FontFace` constructor). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Register a single font at runtime via the CSS `FontFace` API. Returns false if the
 * bytes can't be loaded (e.g. corrupt file) so callers can ignore gracefully.
 */
export async function registerFontFromBase64(
  family: string,
  b64: string,
): Promise<boolean> {
  try {
    const face = new FontFace(family, b64ToBytes(b64).buffer as ArrayBuffer);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch (e) {
    console.error(`[fonts] failed to register "${family}":`, e);
    return false;
  }
}

/**
 * Re-register every previously imported font after a restart. Reads the bytes back
 * from disk (via the Rust `read_font` command) and registers each one.
 */
export async function registerImportedFonts(families: string[]): Promise<void> {
  await Promise.all(
    families.map(async (f) => {
      try {
        const b64 = await fonts.readFont(f);
        await registerFontFromBase64(f, b64);
      } catch {
        /* font file missing on disk — nothing to register */
      }
    }),
  );
}
