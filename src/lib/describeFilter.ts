import type { ColumnFilter, FilterModel } from '../types/filters';
import { getGridLocale, getMessages } from '../i18n';

export function describeFilters(filters: FilterModel) {
  const t = getMessages();
  const grid = getGridLocale();
  function describe(name: string, f: ColumnFilter): string {
    if ('conditions' in f)
      return '(' + f.conditions.map((c) => describe(name, c)).join(' ' + f.operator + ' ') + ')';
    if (f.filterType === 'set')
      return (
        name +
        ' ' +
        t.filter.selectedCount(f.values.length) +
        (f.includeBlanks ? ' ' + t.common.blank : '')
      );
    const label = grid[f.type as keyof typeof grid] ?? f.type;
    if (f.type === 'blank' || f.type === 'notBlank') return [name, label].join(' ');
    const vals =
      f.filterType === 'date'
        ? [f.dateFrom, f.type === 'inRange' ? f.dateTo : null]
        : [f.filter, f.type === 'inRange' ? f.filterTo : null];
    return [name, label, ...vals.filter((v) => v != null)].join(' ');
  }
  return Object.entries(filters)
    .map(([name, f]) => describe(name, f))
    .join(' AND ');
}
