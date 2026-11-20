import type { ColumnMeta } from '../../types/dataset';

interface Props {
  label: string;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  start: number;
}

export function QueryTable({ label, columns, rows, start }: Props) {
  return (
    <div className="query-scroll" tabIndex={0} aria-label={label}>
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            {columns.map((c) => (
              <th scope="col" key={c.name} title={c.duckdbType}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={start + i}>
              <th scope="row">{(start + i + 1).toLocaleString()}</th>
              {row.map((value, j) => (
                <td key={j} className={value === null ? 'null-value' : undefined}>
                  {value ?? 'NULL'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
