import { ROW_HEIGHT_PRESETS } from '../../lib/prefs';
import { useMessages } from '../../i18n';

interface Props {
  value: number;
  onChange: (px: number) => void;
}

export function RowHeightPicker({ value, onChange }: Props) {
  const t = useMessages();
  return (
    <label className="workspace-setting">
      {t.rowHeight.title}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {ROW_HEIGHT_PRESETS.every((p) => p.px !== value) && (
          <option value={value}>{value} px</option>
        )}
        {ROW_HEIGHT_PRESETS.map((p) => (
          <option key={p.key} value={p.px}>
            {t.rowHeight[p.key]}
          </option>
        ))}
      </select>
    </label>
  );
}
