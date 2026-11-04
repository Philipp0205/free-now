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

function circularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b);
  return Math.min(delta, CHAT_COLORS.length - delta);
}

function freeNeighbours(index: number, used: ReadonlySet<number>): number {
  const size = CHAT_COLORS.length;
  const left = (index - 1 + size) % size;
  const right = (index + 1) % size;
  return (used.has(left) ? 0 : 1) + (used.has(right) ? 0 : 1);
}

/**
 * Unused palette entry farthest from colors already taken.
 * Ties prefer a free slot whose neighbours are also free, so a burst of
 * joins does not land on adjacent hues. A remaining tie keeps the person's hash.
 */
export function chooseColor(userId: string, used: ReadonlySet<number>): number {
  const prefer = preferredColor(userId);
  const free: number[] = [];
  for (let index = 0; index < CHAT_COLORS.length; index += 1) {
    if (!used.has(index)) free.push(index);
  }
  if (free.length === 0 || used.size === 0) return prefer;
  let bestDistance = -1;
  const best: number[] = [];
  for (const candidate of free) {
    let nearest: number = CHAT_COLORS.length;
    for (const taken of used) nearest = Math.min(nearest, circularDistance(candidate, taken));
    if (nearest > bestDistance) {
      bestDistance = nearest;
      best.length = 0;
      best.push(candidate);
    } else if (nearest === bestDistance) best.push(candidate);
  }
  let roomiest = -1;
  const roomy: number[] = [];
  for (const candidate of best) {
    const room = freeNeighbours(candidate, used);
    if (room > roomiest) {
      roomiest = room;
      roomy.length = 0;
      roomy.push(candidate);
    } else if (room === roomiest) roomy.push(candidate);
  }
  return roomy.includes(prefer) ? prefer : roomy[0];
}

/**
 * Colors already stored in `prior` stay put. New people take the most distinct
 * free hue, so a join never repaints anyone who already has a color.
 */
export function assignChatColors(userIds: string[], prior: ReadonlyMap<string, number> = new Map()): Map<string, number> {
  const ids = [...new Set(userIds)];
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const id of ids) {
    const saved = prior.get(id);
    if (saved != null && saved >= 0 && saved < CHAT_COLORS.length) {
      assigned.set(id, saved);
      used.add(saved);
    }
  }
  const fresh = ids.filter((id) => !assigned.has(id)).sort();
  for (const id of fresh) {
    const color = chooseColor(id, used);
    used.add(color);
    assigned.set(id, color);
  }
  return assigned;
}
