import { BaseE } from './BaseE';

export class WorkerE extends BaseE {
  run(cb: () => void): void {
    const items = [1, 2, 3];
    items.forEach((n: number) => {
      if (n > 0) {
        this.touch(n, () => { cb(); });
      }
    });
  }

  touch(n: number, done: () => void): void {
    done();
  }
}

export function runLibE(cb: () => void): void {
  const w = new WorkerE();
  w.run(() => { cb(); });
}
