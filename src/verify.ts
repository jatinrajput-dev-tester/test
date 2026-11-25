// Ed25519 check for Discord interaction requests (src/verify.ts).

const SIGNATURE_HEADER = "X-Signature-Ed25519";
const TIMESTAMP_HEADER = "X-Signature-Timestamp";

const KEY_BYTES = 32; // 64 hex chars
const SIGNATURE_BYTES = 64; // 128 hex chars

// Workers has no Node Buffer, so decode by hand. Returns null instead of throwing.
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    bytes[i] = Number.parseInt(pair, 16);
  }
  return bytes;
}

export async function verifyDiscordRequest(
  request: Request,
  publicKeyHex: string,
): Promise<{ ok: true; body: string } | { ok: false; status: number }> {
  const signatureHex = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (!signatureHex || !timestamp || typeof publicKeyHex !== "string") {
    return { ok: false, status: 401 };
  }

  const keyBytes = hexToBytes(publicKeyHex);
  if (!keyBytes || keyBytes.length !== KEY_BYTES) return { ok: false, status: 401 };

  const signatureBytes = hexToBytes(signatureHex);
  if (!signatureBytes || signatureBytes.length !== SIGNATURE_BYTES) {
    return { ok: false, status: 401 };
  }

  try {
    // Read the body once: the stream cannot be re-read, and the caller needs it.
    const body = await request.text();
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    // Discord signs the raw timestamp followed by the raw body, with no separator.
    const message = new TextEncoder().encode(timestamp + body);
    const valid = await crypto.subtle.verify("Ed25519", key, signatureBytes, message);
    return valid ? { ok: true, body } : { ok: false, status: 401 };
  } catch {
    // A bad key or an unreadable body must not crash the Worker.
    return { ok: false, status: 401 };
  }
}
