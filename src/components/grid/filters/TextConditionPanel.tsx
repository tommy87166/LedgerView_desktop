import type { TextFilterType } from '../../../types/filters';
import { useGridLocale, useMessages } from '../../../i18n';
import { TEXT_OPS, opNeedsValue, type TextDraft } from './textFilterModel';

interface Props {
  value: TextDraft;
  onChange: (next: TextDraft) => void;
}

/**
 * 純呈現的文字運算子篩選（對齊 AG Grid 文字篩選），最多兩個條件以 AND/OR 串接。
 * 不在輸入框按 Enter 送出——一律由下方「套用」鈕提交。
 */
export function TextConditionPanel({ value, onChange }: Props) {
  const t = useMessages();
  const grid = useGridLocale();
  const opLabel = (op: TextFilterType): string => grid[op] ?? op;
  const patch = (p: Partial<TextDraft>) => onChange({ ...value, ...p });
  const hasSecond = value.type2 !== 'none';
  const op2 = value.type2 === 'none' ? null : (value.type2 as TextFilterType);

  return (
    <div className="text-cond">
      <select
        value={value.type1}
        onChange={(e) => patch({ type1: e.target.value as TextFilterType })}
      >
        {TEXT_OPS.map((t) => (
          <option key={t} value={t}>
            {opLabel(t)}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder={grid.filterOoo}
        value={value.filter1}
        disabled={!opNeedsValue(value.type1)}
        onChange={(e) => patch({ filter1: e.target.value })}
      />

      {hasSecond && (
        <div className="text-cond-join">
          <label>
            <input
              type="radio"
              name="lv-text-join"
              checked={value.join === 'AND'}
              onChange={() => patch({ join: 'AND' })}
            />
            {grid.andCondition}
          </label>
          <label>
            <input
              type="radio"
              name="lv-text-join"
              checked={value.join === 'OR'}
              onChange={() => patch({ join: 'OR' })}
            />
            {grid.orCondition}
          </label>
        </div>
      )}

      <select
        value={value.type2}
        onChange={(e) => patch({ type2: e.target.value as TextFilterType | 'none' })}
      >
        <option value="none">{t.filter.noSecondCondition}</option>
        {TEXT_OPS.map((t) => (
          <option key={t} value={t}>
            {opLabel(t)}
          </option>
        ))}
      </select>
      {hasSecond && (
        <input
          type="text"
          placeholder={grid.filterOoo}
          value={value.filter2}
          disabled={op2 == null || !opNeedsValue(op2)}
          onChange={(e) => patch({ filter2: e.target.value })}
        />
      )}
    </div>
  );
}
