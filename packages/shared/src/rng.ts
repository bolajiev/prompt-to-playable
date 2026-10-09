export class SeededRng {
  private s: number;
  constructor(seed: number = 123456789) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }
  int(max: number): number { return Math.floor(this.next() * max); }
}
