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

/** Longest block of occupied neighbours on the circular palette. */
export function longestOccupiedRun(used: ReadonlySet<number>): number {
  const size = CHAT_COLORS.length;
  if (used.size === 0) return 0;
  if (used.size >= size) return size;
  let start = 0;
  while (used.has(start)) start += 1;
  let longest = 0;
  let run = 0;
  for (let step = 0; step < size; step += 1) {
    const index = (start + step) % size;
    if (used.has(index)) {
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return longest;
}

/**
 * Free slot that keeps the longest run of occupied neighbours as short as possible.
 * Distance breaks a tie: sit as far as possible from a hue already taken.
 * A remaining tie takes the lowest index, so stored colors and join order stay stable.
 */
export function chooseColor(userId: string, used: ReadonlySet<number>): number {
  if (used.size === 0 || used.size >= CHAT_COLORS.length) return preferredColor(userId);
  let bestRun = CHAT_COLORS.length + 1;
  let bestDistance = -1;
  const best: number[] = [];
  for (let candidate = 0; candidate < CHAT_COLORS.length; candidate += 1) {
    if (used.has(candidate)) continue;
    const next = new Set(used);
    next.add(candidate);
    const run = longestOccupiedRun(next);
    let nearest: number = CHAT_COLORS.length;
    for (const taken of used) nearest = Math.min(nearest, circularDistance(candidate, taken));
    if (run < bestRun || (run === bestRun && nearest > bestDistance)) {
      bestRun = run;
      bestDistance = nearest;
      best.length = 0;
      best.push(candidate);
    } else if (run === bestRun && nearest === bestDistance) best.push(candidate);
  }
  return best[0] ?? preferredColor(userId);
}

/**
 * Colors already stored in `prior` stay put. New people take a free hue that
 * keeps occupied neighbours from forming a longer run.
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
