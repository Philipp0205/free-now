/**
 * Twelve hues tuned so the same hex is WCAG AA on both black and white, so a
 * bar, a name, or white initials on it read in light and dark. Each person keeps
 * one slot in users.color (see assignUserColor in db.ts).
 */
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

/** Hex for a stored slot. Before someone's first circle there is no slot yet, so the hash slot stands in. */
export function colorHex(userId: string, slot: number | null | undefined): string {
  const index = slot != null && slot >= 0 && slot < CHAT_COLORS.length ? slot : preferredColor(userId);
  return CHAT_COLORS[index];
}

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
 * For every subset of the wheel, the run lengths from that subset through a full
 * circle, choosing later slots to keep the whole sequence lexicographically smallest.
 * Looking only at the current join parks 8 members as four pairs, and the 9th
 * then bridges two pairs into a run of 5. The lookahead instead grows three
 * triples, so 9 members stay at a run of 3.
 */
let runPlans: number[][] | null = null;

function colorPlans(): number[][] {
  if (runPlans) return runPlans;
  const size = CHAT_COLORS.length;
  const full = (1 << size) - 1;
  const runOf = new Uint8Array(full + 1);
  for (let bits = 0; bits <= full; bits += 1) {
    const used = new Set<number>();
    for (let index = 0; index < size; index += 1) if (bits & (1 << index)) used.add(index);
    runOf[bits] = longestOccupiedRun(used);
  }
  const plans: number[][] = new Array(full + 1);
  plans[full] = [runOf[full]];
  for (let bits = full - 1; bits >= 0; bits -= 1) {
    let best: number[] | null = null;
    for (let index = 0; index < size; index += 1) {
      if (bits & (1 << index)) continue;
      const child = plans[bits | (1 << index)];
      if (!best || lexLess(child, best)) best = child;
    }
    plans[bits] = [runOf[bits], ...(best ?? [])];
  }
  runPlans = plans;
  return plans;
}

function lexLess(left: readonly number[], right: readonly number[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return left.length < right.length;
}

function nearestDistance(candidate: number, used: ReadonlySet<number>): number {
  let nearest: number = CHAT_COLORS.length;
  for (const taken of used) nearest = Math.min(nearest, circularDistance(candidate, taken));
  return nearest;
}

/**
 * Free slot that minimises the longest occupied run across the sizes still to come.
 * Distance breaks a tie between equal futures. Stored colors are whoever already
 * holds them; this only picks a hue nobody has.
 */
export function chooseColor(userId: string, used: ReadonlySet<number>): number {
  if (used.size === 0 || used.size >= CHAT_COLORS.length) return preferredColor(userId);
  const plans = colorPlans();
  let mask = 0;
  for (const index of used) mask |= 1 << index;
  let bestSlot = 0;
  let bestPlan: number[] | null = null;
  let bestDistance = -1;
  for (let candidate = 0; candidate < CHAT_COLORS.length; candidate += 1) {
    if (used.has(candidate)) continue;
    const plan = plans[mask | (1 << candidate)];
    const distance = nearestDistance(candidate, used);
    const same = bestPlan !== null && plan.length === bestPlan.length && plan.every((value, index) => value === bestPlan?.[index]);
    if (!bestPlan || lexLess(plan, bestPlan) || (same && distance > bestDistance)) {
      bestSlot = candidate;
      bestPlan = plan;
      bestDistance = distance;
    }
  }
  return bestSlot;
}

/**
 * Colors already stored in `prior` stay put. New people take a free hue whose
 * later prefixes keep neighbouring runs as short as one growing circle allows.
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
