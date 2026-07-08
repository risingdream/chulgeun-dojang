import { describe, expect, it } from "vitest";
import { createQrToken, hashQrNonce, verifyQrToken } from "./qr-token";

const secret = "test-secret-with-enough-entropy";

describe("qr token", () => {
  it("verifies signed kiosk qr claims inside the valid window", async () => {
    const token = await createQrToken(
      {
        workspaceId: "ws_1",
        kioskId: "kiosk_1",
        purpose: "clock",
        issuedAt: 1_000,
        ttlSeconds: 30,
        nonce: "nonce_1"
      },
      secret
    );

    const result = await verifyQrToken(token, secret, 1_010);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject({
        version: 1,
        workspaceId: "ws_1",
        kioskId: "kiosk_1",
        purpose: "clock",
        issuedAt: 1_000,
        expiresAt: 1_030,
        nonce: "nonce_1"
      });
    }
  });

  it("rejects expired qr tokens", async () => {
    const token = await createQrToken(
      {
        workspaceId: "ws_1",
        kioskId: "kiosk_1",
        purpose: "clock",
        issuedAt: 1_000,
        ttlSeconds: 30,
        nonce: "nonce_2"
      },
      secret
    );

    const result = await verifyQrToken(token, secret, 1_031);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampered qr tokens", async () => {
    const token = await createQrToken(
      {
        workspaceId: "ws_1",
        kioskId: "kiosk_1",
        purpose: "clock",
        issuedAt: 1_000,
        ttlSeconds: 30,
        nonce: "nonce_3"
      },
      secret
    );
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(decodeBase64UrlUtf8(payload ?? ""));
    decoded.workspaceId = "ws_attacker";
    const tamperedPayload = encodeBase64UrlUtf8(JSON.stringify(decoded));

    const result = await verifyQrToken(`${tamperedPayload}.${signature}`, secret, 1_010);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("hashes qr nonce for replay checks without storing the raw nonce", async () => {
    const hash = await hashQrNonce({ workspaceId: "ws_1", kioskId: "kiosk_1", nonce: "raw-nonce" });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("raw-nonce");
  });
});

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64UrlUtf8(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
