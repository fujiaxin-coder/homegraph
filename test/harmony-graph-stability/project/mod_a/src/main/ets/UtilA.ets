export function helperA(n: number): number {
  const wrap = (x: number): number => x + 1;
  return wrap(n);
}

export function mapAllA(xs: number[]): number[] {
  return xs.map((v: number) => helperA(v));
}
