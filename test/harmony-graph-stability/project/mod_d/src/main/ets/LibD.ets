import { BaseD } from './BaseD';

export class WorkerD extends BaseD {
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

export function runLibD(cb: () => void): void {
  const w = new WorkerD();
  w.run(() => { cb(); });
}
