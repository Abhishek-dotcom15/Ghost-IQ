/**
 * Small, fast, seedable PRNG (mulberry32). Deterministic across platforms, which is
 * what reproducible personas need; not for cryptography.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => probability > 0 && next() < probability,
    pick: <T>(items: readonly T[]) => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

/** Derives a stable 32-bit seed from a base seed and any labels (FNV-1a). */
export function deriveSeed(seed: number, ...labels: Array<string | number>): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0);
  for (const label of labels) {
    const text = String(label);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff; // separator, so ("ab","c") != ("a","bc")
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
