/**
 * Deterministic Pseudo-Random Number Generator (Mulberry32)
 *
 * Guarantees 100% reproducible scenario generation across platforms and runs
 * given the same fixed seed.
 */
export class SeededPRNG {
  private state: number;

  constructor(seed: number = 42) {
    this.state = seed >>> 0;
  }

  /**
   * Generates a pseudo-random floating point number in [0, 1).
   */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generates a pseudo-random integer in [min, max] inclusive.
   */
  public nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Generates a pseudo-random float in [min, max].
   */
  public nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Randomly picks one element from an array.
   */
  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty array.");
    }
    const idx = this.nextInt(0, items.length - 1);
    return items[idx];
  }

  /**
   * Returns a shuffled copy of an array using the Fisher-Yates algorithm.
   */
  public shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  /**
   * Returns true with the given probability in [0, 1].
   */
  public chance(probability: number): boolean {
    return this.next() < probability;
  }
}
