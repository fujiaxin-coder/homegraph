/**
 * Bucket C: high-fanout-shaped API that must NOT be mass-wired from unrelated callers.
 * Presence of the symbols is intentional; callsMustNot forbids flood edges.
 */
export class FanoutTrap {
  static getInstance(): FanoutTrap {
    return new FanoutTrap();
  }

  error(_msg: string): void {}

  info(_msg: string): void {}
}
