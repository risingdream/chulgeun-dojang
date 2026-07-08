export type QrConsumptionStore = {
  insertIfAbsent(qrNonceHash: string): Promise<boolean>;
};

export type ConsumeQrResult = { ok: true } | { ok: false; reason: "already_used" };

export async function consumeQrOnce(
  store: QrConsumptionStore,
  qrNonceHash: string
): Promise<ConsumeQrResult> {
  const inserted = await store.insertIfAbsent(qrNonceHash);
  if (!inserted) {
    return { ok: false, reason: "already_used" };
  }
  return { ok: true };
}
