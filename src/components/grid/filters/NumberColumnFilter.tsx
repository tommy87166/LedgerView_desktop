import { useCallback, useRef, useState } from 'react';
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react';
import type { IAfterGuiAttachedParams } from 'ag-grid-community';
import { useGridLocale, useMessages } from '../../../i18n';
import type { ColumnFilter, NumberFilterCondition, NumberFilterType } from '../../../types/filters';

const ops: NumberFilterType[] = [
  'equals',
  'notEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'inRange',
  'blank',
  'notBlank',
];
const empty = (): NumberFilterCondition => ({ filterType: 'number', type: 'equals' });
const numeric = (v: string | number | undefined) =>
  v != null && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(v));

export function NumberColumnFilter({
  api,
  column,
  onModelChange,
}: CustomFilterProps<unknown, unknown, ColumnFilter | null>) {
  const grid = useGridLocale();
  const t = useMessages();
  const close = useRef<(() => void) | undefined>(undefined);
  const [items, setItems] = useState<NumberFilterCondition[]>([empty()]);
  const [join, setJoin] = useState<'AND' | 'OR'>('AND');
  useGridFilter({
    doesFilterPass: () => true,
    afterGuiAttached: useCallback(
      (p?: IAfterGuiAttachedParams) => {
        close.current = p?.hidePopup;
        const model = api.getColumnFilterModel(column.getColId()) as ColumnFilter | null;
        if (model && 'conditions' in model) {
          setItems(
            model.conditions.filter((c): c is NumberFilterCondition => c.filterType === 'number'),
          );
          setJoin(model.operator);
        } else {
          setItems([model?.filterType === 'number' ? model : empty()]);
          setJoin('AND');
        }
      },
      [api, column],
    ),
  });
  const patch = (index: number, fields: Partial<NumberFilterCondition>) =>
    setItems(items.map((v, i) => {
      if (i !== index) return v;
      const next = { ...v, ...fields };
      if (next.type !== 'inRange') delete next.filterTo;
      if (next.type === 'blank' || next.type === 'notBlank') delete next.filter;
      return next;
    }));
  const valid = items.every(
    (i) =>
      ['blank', 'notBlank'].includes(i.type) ||
      (numeric(i.filter) && (i.type !== 'inRange' || numeric(i.filterTo))),
  );
  const commit = (model: ColumnFilter | null) => {
    onModelChange(model);
    close.current?.();
  };
  return (
    <div className="text-column-filter">
      {items.map((item, i) => (
        <div className="text-cond" key={i}>
          {i > 0 && (
            <select
              aria-label="AND / OR"
              value={join}
              onChange={(e) => setJoin(e.target.value as 'AND' | 'OR')}
            >
              <option value="AND">{grid.andCondition}</option>
              <option value="OR">{grid.orCondition}</option>
            </select>
          )}
          <select
            aria-label={grid.filterOoo}
            value={item.type}
            onChange={(e) => {
              if (!e.target.value) setItems(items.slice(0, 1));
              else patch(i, { type: e.target.value as NumberFilterType });
            }}
          >
            {i > 0 && <option value="">{t.filter.noSecondCondition}</option>}
            {ops.map((op) => (
              <option key={op} value={op}>
                {grid[op]}
              </option>
            ))}
          </select>
          {!['blank', 'notBlank'].includes(item.type) && (
            <input
              aria-label={grid.filterOoo}
              placeholder={grid.filterOoo}
              inputMode="decimal"
              value={item.filter ?? ''}
              onChange={(e) => patch(i, { filter: e.target.value })}
            />
          )}
          {item.type === 'inRange' && (
            <input
              aria-label={grid.inRangeEnd}
              placeholder={grid.inRangeEnd}
              inputMode="decimal"
              value={item.filterTo ?? ''}
              onChange={(e) => patch(i, { filterTo: e.target.value })}
            />
          )}
        </div>
      ))}
      {items.length === 1 && (
        <select
          value=""
          aria-label={t.filter.noSecondCondition}
          onChange={(e) =>
            setItems([...items, { ...empty(), type: e.target.value as NumberFilterType }])
          }
        >
          <option value="">{t.filter.noSecondCondition}</option>
          {ops.map((op) => (
            <option key={op} value={op}>
              {grid[op]}
            </option>
          ))}
        </select>
      )}
      <div className="filter-footer">
        <button className="btn" onClick={() => commit(null)}>
          {grid.clearFilter}
        </button>
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() =>
            commit(
              items.length === 1
                ? items[0]
                : { filterType: 'number', operator: join, conditions: items },
            )
          }
        >
          {grid.applyFilter}
        </button>
      </div>
    </div>
  );
}
