import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useMessages } from '../../i18n';
import type { NotebookSource } from '../../types/notebook';
import { IconDatabase, IconSnapshot } from '../common/icons';

interface Props {
  sources: NotebookSource[];
  onPick: (name: string) => void;
}

export function NotebookSourcePicker({ sources, onPick }: Props) {
  const t = useMessages().notebook;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(0);
  const search = useRef({ prefix: '', time: 0 });
  const [position, setPosition] = useState<CSSProperties | null>(null);

  function open(index: number) {
    const rect = trigger.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 10;
    const above = rect.top - 10;
    const height = Math.min(280, sources.length * 32 + 10);
    const up = below < height && above > below;
    firstFocus.current = index;
    search.current.prefix = '';
    setPosition({
      left: Math.max(6, Math.min(rect.left, window.innerWidth - 246)),
      ...(up ? { bottom: window.innerHeight - rect.top + 3 } : { top: rect.bottom + 3 }),
      maxHeight: Math.min(280, Math.max(0, up ? above : below)),
    });
  }

  useLayoutEffect(() => {
    if (position) menu.current?.querySelectorAll('button')[firstFocus.current]?.focus();
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const scroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [position]);

  return (
    <div
      className="sql-source-picker"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPosition(null);
      }}
    >
      <button
        className="sql-source-trigger"
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!position}
        aria-controls={position ? id : undefined}
        onClick={() => (position ? setPosition(null) : open(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open(e.key === 'ArrowUp' ? sources.length - 1 : 0);
          }
        }}
      >
        {t.sources}
        <span className="sql-source-chevron" aria-hidden="true" />
      </button>
      {position && (
        <div
          className="sql-source-menu"
          ref={menu}
          role="menu"
          id={id}
          aria-label={t.sources}
          style={position}
          onKeyDown={(e) => {
            const items = Array.from(e.currentTarget.querySelectorAll('button'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            switch (e.key) {
              case 'Escape':
                e.preventDefault();
                setPosition(null);
                trigger.current?.focus();
                return;
              case 'ArrowDown':
                next = (index + 1) % items.length;
                break;
              case 'ArrowUp':
                next = (index + items.length - 1) % items.length;
                break;
              case 'Home':
                next = 0;
                break;
              case 'End':
                next = items.length - 1;
                break;
              default: {
                if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.altKey || e.metaKey)
                  return;
                const now = performance.now();
                const prefix =
                  (now - search.current.time < 600 ? search.current.prefix : '') +
                  e.key.toLowerCase();
                search.current = { prefix, time: now };
                next = sources.findIndex((s) => s.name.toLowerCase().startsWith(prefix));
                if (next < 0) return;
              }
            }
            e.preventDefault();
            items[next]?.focus();
          }}
        >
          {sources.map((source) => {
            const kind = source.isSnapshot ? t.snapshot : t.database;
            const label = kind + ' · ' + source.name;
            return (
              <button
                key={source.name}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-label={label}
                title={label}
                onClick={() => {
                  setPosition(null);
                  onPick(source.name);
                }}
              >
                {source.isSnapshot ? (
                  <IconSnapshot size={16} aria-hidden="true" />
                ) : (
                  <IconDatabase size={16} />
                )}
                <span>{source.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
