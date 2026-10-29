import { helperD } from '../../../../mod_d/src/main/ets/UtilD';

export function helperE(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(helperD(n));
}

export function mapAllE(xs: number[]): number[] {
  return xs.map((v: number) => helperE(v));
}
