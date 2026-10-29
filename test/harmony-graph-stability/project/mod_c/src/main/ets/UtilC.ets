import { helperB } from '../../../../mod_b/src/main/ets/UtilB';

export function helperC(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(helperB(n));
}

export function mapAllC(xs: number[]): number[] {
  return xs.map((v: number) => helperC(v));
}
