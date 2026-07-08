import { describe, expect, it } from "vitest";
import { consumeQrOnce, type QrConsumptionStore } from "./qr-replay";

class MemoryQrConsumptionStore implements QrConsumptionStore {
  private readonly consumed = new Set<string>();

  async insertIfAbsent(qrNonceHash: string): Promise<boolean> {
    if (this.consumed.has(qrNonceHash)) {
      return false;
    }
    this.consumed.add(qrNonceHash);
    return true;
  }
}

describe("qr replay policy", () => {
  it("allows the first scan to consume a qr nonce", async () => {
    const store = new MemoryQrConsumptionStore();

    const result = await consumeQrOnce(store, "qr_hash_1");

    expect(result).toEqual({ ok: true });
  });

  it("rejects another scan using the same qr nonce", async () => {
    const store = new MemoryQrConsumptionStore();
    await consumeQrOnce(store, "qr_hash_1");

    const result = await consumeQrOnce(store, "qr_hash_1");

    expect(result).toEqual({ ok: false, reason: "already_used" });
  });
});
