import { expect, it } from 'vitest';
import { describeFilters } from './describeFilter';

it('omits obsolete numeric bounds from snapshot descriptions', () => {
  for (const type of ['blank', 'notBlank', 'equals', 'inRange'] as const) {
    const description = describeFilters({ amount: { filterType: 'number', type, filter: '100', filterTo: '200' } });
    expect(description.includes('100')).toBe(type === 'equals' || type === 'inRange');
    expect(description.includes('200')).toBe(type === 'inRange');
  }
});
