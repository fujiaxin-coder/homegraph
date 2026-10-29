import { helperC } from '../../../../mod_c/src/main/ets/UtilC';

export function helperD(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(helperC(n));
}

export function mapAllD(xs: number[]): number[] {
  return xs.map((v: number) => helperD(v));
}
