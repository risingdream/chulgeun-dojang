export type QrPurpose = "clock";

export type CreateQrTokenInput = {
  workspaceId: string;
  kioskId: string;
  purpose: QrPurpose;
  issuedAt: number;
  ttlSeconds: number;
  nonce?: string;
};

export type QrClaims = {
  version: 1;
  workspaceId: string;
  kioskId: string;
  purpose: QrPurpose;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type VerifyQrTokenResult =
  | { ok: true; claims: QrClaims }
  | { ok: false; reason: "malformed" | "invalid_signature" | "expired" | "not_yet_valid" };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function createQrToken(input: CreateQrTokenInput, secret: string): Promise<string> {
  if (input.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be positive");
  }

  const claims: QrClaims = {
    version: 1,
    workspaceId: input.workspaceId,
    kioskId: input.kioskId,
    purpose: input.purpose,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + input.ttlSeconds,
    nonce: input.nonce ?? createNonce()
  };

  const payload = base64UrlEncodeUtf8(JSON.stringify(claims));
  const signature = await hmacSha256Base64Url(payload, secret);

  return `${payload}.${signature}`;
}

export async function verifyQrToken(
  token: string,
  secret: string,
  now: number
): Promise<VerifyQrTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }

  const [payload, signature] = parts as [string, string];
  const expectedSignature = await hmacSha256Base64Url(payload, secret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const claims = decodeClaims(payload);
  if (!claims) {
    return { ok: false, reason: "malformed" };
  }

  if (now < claims.issuedAt) {
    return { ok: false, reason: "not_yet_valid" };
  }

  if (now > claims.expiresAt) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

export async function hashQrNonce(input: {
  workspaceId: string;
  kioskId: string;
  nonce: string;
}): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${input.workspaceId}.${input.kioskId}.${input.nonce}`)
  );
  return bytesToHex(new Uint8Array(bytes));
}

function decodeClaims(payload: string): QrClaims | null {
  try {
    const value = JSON.parse(base64UrlDecodeUtf8(payload));
    if (!isQrClaims(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isQrClaims(value: unknown): value is QrClaims {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<QrClaims>;
  const issuedAt = candidate.issuedAt;
  const expiresAt = candidate.expiresAt;

  return (
    candidate.version === 1 &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.kioskId === "string" &&
    candidate.kioskId.length > 0 &&
    candidate.purpose === "clock" &&
    typeof issuedAt === "number" &&
    Number.isInteger(issuedAt) &&
    typeof expiresAt === "number" &&
    Number.isInteger(expiresAt) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length > 0 &&
    expiresAt >= issuedAt
  );
}

async function hmacSha256Base64Url(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function base64UrlEncodeUtf8(value: string): string {
  return bytesToBase64Url(textEncoder.encode(value));
}

function base64UrlDecodeUtf8(value: string): string {
  return textDecoder.decode(base64UrlToBytes(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
