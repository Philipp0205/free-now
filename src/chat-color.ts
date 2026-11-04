/** Twelve hues tuned so the same hex is WCAG AA on both black and white. */
export const CHAT_COLORS = [
  "#dd341a",
  "#b26017",
  "#857532",
  "#6d7c34",
  "#3c852e",
  "#2e8559",
  "#31817b",
  "#267da8",
  "#466de5",
  "#7d66c5",
  "#ad47cf",
  "#de158a",
] as const;

export function preferredColor(userId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CHAT_COLORS.length;
}

/** Stable across devices. Members who would share a hue take the next free one when a slot remains. */
export function assignChatColors(userIds: string[]): Map<string, number> {
  const ids = [...new Set(userIds)].sort();
  const used = new Set<number>();
  const assigned = new Map<string, number>();
  const pending: string[] = [];
  for (const id of ids) {
    const prefer = preferredColor(id);
    if (used.has(prefer)) pending.push(id);
    else {
      used.add(prefer);
      assigned.set(id, prefer);
    }
  }
  for (const id of pending) {
    const prefer = preferredColor(id);
    let color = prefer;
    for (let step = 1; step < CHAT_COLORS.length; step += 1) {
      const candidate = (prefer + step) % CHAT_COLORS.length;
      if (!used.has(candidate)) {
        color = candidate;
        break;
      }
    }
    used.add(color);
    assigned.set(id, color);
  }
  return assigned;
}
