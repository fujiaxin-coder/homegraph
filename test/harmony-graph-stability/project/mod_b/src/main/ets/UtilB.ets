import { helperA } from '../../../../mod_a/src/main/ets/UtilA';
import { DateFmt } from '../../../../mod_a/src/main/ets/DateFmt';

export function helperB(n: number): number {
  const wrap = (x: number): number => x + 1;
  // Bucket A: cross-module Class.method (exact name recall)
  DateFmt.weekTitle();
  return wrap(helperA(n));
}

export function mapAllB(xs: number[]): number[] {
  return xs.map((v: number) => helperB(v));
}
