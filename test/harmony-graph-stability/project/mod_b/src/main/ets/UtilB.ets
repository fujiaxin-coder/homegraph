import { helperA } from '../../../../mod_a/src/main/ets/UtilA';

export function helperB(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(helperA(n));
}

export function mapAllB(xs: number[]): number[] {
  return xs.map((v: number) => helperB(v));
}
