import { expect, it } from 'vitest';
import { exactAverage, formatNumber } from './numbers';

it('keeps large integers and decimal cents when formatting grid values and totals', () => {
  expect(formatNumber('9007199254740993.01234')).toBe(
    BigInt('9007199254740993').toLocaleString() + '.01234',
  );
  expect(formatNumber('-99.995', 2)).toBe('-100');
  expect(formatNumber('-0.0001', 2)).toBe('0');
  expect(formatNumber(null)).toBe('—');
});
it('rounds the average of exact decimal amounts after division', () => {
  expect(exactAverage('18014398509481986.01', 2, null)).toBe('9007199254740993.01');
  expect(exactAverage('-0.05', 2, null)).toBe('-0.03');
  expect(exactAverage(null, 0, null)).toBeNull();
});
