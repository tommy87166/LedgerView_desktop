import { useEffect, useRef } from 'react';
import type { DatasetMeta } from '../../types/dataset';
import { useDatasets } from '../../store/datasets';
import { useMessages } from '../../i18n';

interface Props {
  dataset: DatasetMeta;
  onClose: () => void;
}

/** 顯示/隱藏欄位的浮層（每分頁獨立、session-only）。列號欄不在此清單。 */
export function ColumnPicker({ dataset, onClose }: Props) {
  const t = useMessages();
  const setHiddenColumns = useDatasets((s) => s.setHiddenColumns);
  const ref = useRef<HTMLDivElement>(null);
  const hidden = new Set(dataset.hiddenColumns ?? []);

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

  const toggle = (name: string) => {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHiddenColumns(dataset.id, [...next]);
  };

  return (
    <div className="col-picker" ref={ref} role="menu">
      <div className="col-picker-head">
        <span>{t.columns.title}</span>
        <span className="col-picker-actions">
          <button type="button" onClick={() => setHiddenColumns(dataset.id, [])}>
            {t.columns.showAll}
          </button>
          <button
            type="button"
            onClick={() =>
              setHiddenColumns(
                dataset.id,
                dataset.columns.map((c) => c.name),
              )
            }
          >
            {t.columns.hideAll}
          </button>
        </span>
      </div>
      <div className="col-picker-list">
        {dataset.columns.map((c) => (
          <label key={c.name} className="col-picker-item">
            <input type="checkbox" checked={!hidden.has(c.name)} onChange={() => toggle(c.name)} />
            <span>{c.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
