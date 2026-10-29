import { BaseC } from './BaseC';

export class WorkerC extends BaseC {
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

export function runLibC(cb: () => void): void {
  const w = new WorkerC();
  w.run(() => { cb(); });
}
