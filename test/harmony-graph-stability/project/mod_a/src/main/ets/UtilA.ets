/** Bucket B: non-exported helper — must remain reachable without being an RTA entry. */
function hiddenHelperA(n: number): number {
  return n + 2;
}

export function helperA(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(hiddenHelperA(n));
}

export function mapAllA(xs: number[]): number[] {
  return xs.map((v: number) => helperA(v));
}
