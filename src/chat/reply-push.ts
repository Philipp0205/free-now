/** Hold a coming-reply push briefly so a quick ETA is part of the same notice. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export const REPLY_PUSH_WAIT_MS = 4000;

export function scheduleReplyPush(key: string, fire: () => Promise<void>): void {
  cancelReplyPush(key);
  const timer = setTimeout(() => {
    pending.delete(key);
    void fire().catch((error: unknown) => {
      console.error("reply push failed", error instanceof Error ? error.message : error);
    });
  }, REPLY_PUSH_WAIT_MS);
  timer.unref?.();
  pending.set(key, timer);
}

export function cancelReplyPush(key: string): boolean {
  const timer = pending.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  pending.delete(key);
  return true;
}
