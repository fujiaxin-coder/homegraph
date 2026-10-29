import { BaseA } from './BaseA';

export class WorkerA extends BaseA {
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

export function runLibA(cb: () => void): void {
  const w = new WorkerA();
  w.run(() => { cb(); });
}
