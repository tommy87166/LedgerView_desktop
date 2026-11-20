import { useEffect, useRef } from 'react';
import { ROW_HEIGHT_PRESETS } from '../../lib/prefs';
import { useMessages } from '../../i18n';
import type { Messages } from '../../i18n';

interface Props {
  value: number;
  onChange: (px: number) => void;
  onClose: () => void;
}

/** 行距（列高）選擇浮層：密度預設，全域、持久化。沿用 ColumnPicker 的關閉行為。 */
export function RowHeightPicker({ value, onChange, onClose }: Props) {
  const t = useMessages();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="col-picker row-height-picker" ref={ref} role="menu">
      <div className="col-picker-head">
        <span>{t.rowHeight.title}</span>
      </div>
      <div className="col-picker-list">
        {ROW_HEIGHT_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="menuitemradio"
            aria-checked={p.px === value}
            className={`col-picker-item rh-item ${p.px === value ? 'active' : ''}`}
            onClick={() => onChange(p.px)}
          >
            <span className="rh-check" aria-hidden>
              {p.px === value ? '✓' : ''}
            </span>
            <span>{t.rowHeight[p.key as keyof Messages['rowHeight']] ?? p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
