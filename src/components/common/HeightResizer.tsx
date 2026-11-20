import { useRef } from 'react';

interface Props {
  controls: string;
  label: string;
  edge: 'top' | 'bottom';
  height: number;
  min: number;
  max?: number;
  onResize: (height: number) => void;
}

export function HeightResizer({ controls, label, edge, height, min, max, onResize }: Props) {
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const direction = edge === 'top' ? -1 : 1;

  function move(from: number, delta: number) {
    onResize(Math.max(min, Math.min(max ?? Infinity, Math.round(from + direction * delta))));
  }

  return (
    <div className="height-resizer" role="separator" tabIndex={0}
      aria-label={label} title={label} aria-controls={controls} aria-orientation="horizontal"
      aria-valuenow={height} aria-valuemin={min} aria-valuemax={max} aria-valuetext={height + ' px'}
      onPointerDown={(e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, y: e.clientY, height };
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start?.pointerId === e.pointerId) move(start.height, e.clientY - start.y);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        move(height, e.key === 'ArrowDown' ? 20 : -20);
      }}
    />
  );
}
