import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short recovery code, XXXX-XXXX-XXXX, avoiding ambiguous characters. */
export function humanCode(): string {
  const raw = Array.from(crypto.randomBytes(12), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * Accept a recovery code, a buzz URL, or a pasted curl command.
 * A 12-character code is returned in XXXX-XXXX-XXXX form.
 */
export function extractBuzzSecret(input: string): string {
  const text = input.trim();
  const fromUrl = text.match(/\/api\/buzz\/([^/?\s"'\\]+)/i);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]);
    } catch {
      return fromUrl[1];
    }
  }
  const compact = text.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (/^[A-Z2-9]{12}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
  }
  return text.replace(/\s+/g, "");
}
