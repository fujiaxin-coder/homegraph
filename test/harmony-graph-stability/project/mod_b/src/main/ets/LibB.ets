import { BaseB } from './BaseB';

export class WorkerB extends BaseB {
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

export function runLibB(cb: () => void): void {
  const w = new WorkerB();
  w.run(() => { cb(); });
}
