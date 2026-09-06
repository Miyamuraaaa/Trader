import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_DOWN, toExpNeg: -20, toExpPos: 40 });

export type ExactNumber = Decimal;

export function exact(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

export function toAtomic(amount: Decimal | string | number, decimals: number): string {
  const dec = exact(amount);
  const multiplier = exact(10).pow(decimals);
  return dec.mul(multiplier).floor().toFixed(0);
}

export function fromAtomic(atomic: string | number | bigint, decimals: number): Decimal {
  const dec = exact(atomic.toString());
  const divisor = exact(10).pow(decimals);
  return dec.div(divisor);
}

export function min(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}

export function max(a: Decimal, b: Decimal): Decimal {
  return a.gte(b) ? a : b;
}
