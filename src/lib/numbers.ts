// Format DECIMAL and integer IPC strings without converting them to binary floats.
export function formatNumber(value: string | null, digits?: number): string {
  if (value === null) return '—';
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const places = digits === undefined ? fraction.length : Math.min(digits, fraction.length);
  let units = BigInt(whole + fraction.slice(0, places));
  if (fraction[places] >= '5') units++;
  const text = units.toString().padStart(places + 1, '0');
  const decimal = places ? text.slice(-places).replace(/0+$/, '') : '';
  return (
    (negative && units !== 0n ? '-' : '') +
    BigInt(places ? text.slice(0, -places) : text).toLocaleString() +
    (decimal ? '.' + decimal : '')
  );
}

export function exactAverage(
  sum: string | null,
  count: number,
  fallback: string | null,
): string | null {
  if (!sum || !count || !/^-?\d+(\.\d+)?$/.test(sum)) return fallback;
  const [whole, fraction = ''] = sum.replace(/^-/, '').split('.');
  const denominator = BigInt(count) * 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * 100n;
  const rounded = ((2n * numerator + denominator) / (2n * denominator)).toString().padStart(3, '0');
  return (sum.startsWith('-') ? '-' : '') + rounded.slice(0, -2) + '.' + rounded.slice(-2);
}
