import { useEffect, useRef } from 'react';
import { useMessages } from '../../i18n';

export interface CellMenuState {
  /** 視窗座標（clientX/Y）。 */
  x: number;
  y: number;
  colId: string;
  value: unknown;
}

interface Props {
  menu: CellMenuState;
  onCopy: () => void;
  onCopyArray: () => void;
  /** 「複製成不重複陣列」僅在文字欄顯示。 */
  showCopyArray: boolean;
  onFilter: () => void;
  onClose: () => void;
}

/** Cell 右鍵自訂選單（AG Grid Community 無內建 context menu）。 */
export function CellContextMenu({
  menu,
  onCopy,
  onCopyArray,
  showCopyArray,
  onFilter,
  onClose,
}: Props) {
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
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDocMouse);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div className="cell-menu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu">
      <button type="button" className="cell-menu-item" onClick={onCopy}>
        {t.cellMenu.copyValue}
      </button>
      <button type="button" className="cell-menu-item" onClick={onFilter}>
        {t.cellMenu.filterBy(menu.colId)}
      </button>
      {showCopyArray && (
        <button type="button" className="cell-menu-item" onClick={onCopyArray}>
          {t.cellMenu.copyArray}
        </button>
      )}
    </div>
  );
}
