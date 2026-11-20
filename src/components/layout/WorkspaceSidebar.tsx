import { useEffect, useRef, useState } from 'react';
import { useMessages } from '../../i18n';
import { request } from '../../lib/native';
import { useDatasets } from '../../store/datasets';
import { useSnapshots } from '../../store/snapshots';
import { useUi } from '../../store/ui';
import type { SnapshotMeta } from '../../types/snapshot';
import { IconDatabase, IconSidebar, Logo } from '../common/icons';
import { WorkspaceSettings } from './WorkspaceSettings';
import { SnapshotList } from '../snapshots/SnapshotList';

import { NotebookList } from '../notebooks/NotebookList';

interface Props {
  onNotebookNavigate: () => void;
  importing: boolean;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPreview: (snap: SnapshotMeta) => void;
}

export function WorkspaceSidebar({
  importing,
  onOpen,
  onSelect,
  onClose,
  onPreview,
  onNotebookNavigate,
}: Props) {
  const t = useMessages();
  const sources = useDatasets((s) => s.datasets).filter((d) => !d.ephemeral);
  const activeId = useDatasets((s) => s.activeId);
  const snapshotCount = useSnapshots((s) => s.snapshots.length);
  const persistent = useUi((s) => s.persistent);
  const [diskAvail, setDiskAvail] = useState<string | null>(null);
  const [width, setWidth] = useState(274);
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const toggleLabel = collapsed ? t.sidebar.expand : t.sidebar.collapse;
  const sidebar = useRef<HTMLElement>(null);
  const dragOffset = useRef(0);
  const widthBeforeDrag = useRef(width);

  useEffect(() => {
    if (!persistent) return;
    let alive = true;
    void request('diskSpace', {})
      .then((bytes) => {
        if (alive) setDiskAvail(bytes == null ? null : (bytes / 1024 ** 3).toFixed(1) + ' GiB');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [persistent, sources.length, snapshotCount]);

  const resize = (next: number) =>
    setWidth(Math.max(200, Math.min(next, 420, window.innerWidth * 0.42)));

  return (
    <aside
      id="workspace-sidebar"
      className={collapsed ? 'workspace-sidebar sources-collapsed' : 'workspace-sidebar'}
      ref={sidebar}
      style={collapsed ? undefined : { width }}
      aria-label={t.sidebar.title}
    >
      <header className="sidebar-brand">
        {!collapsed && (
          <>
            <Logo size={23} aria-hidden="true" />
            <h1>{t.appName}</h1>
          </>
        )}
        <button
          ref={toggle}
          className="quiet-button sidebar-toggle"
          aria-controls="workspace-sources"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setCollapsed((value) => !value)}
        >
          <IconSidebar collapsed={collapsed} />
          {collapsed && <span>{t.sidebar.title}</span>}
        </button>
      </header>
      <div className="sidebar-scroll" id="workspace-sources">
        <section aria-labelledby="sources-heading">
          <div className="sidebar-section-head">
            <h2 id="sources-heading">{t.sidebar.databases}</h2>
            <button
              className="open-source"
              onClick={onOpen}
              disabled={importing}
              title={t.topbar.openFileTooltip}
            >
              {importing ? t.topbar.importing : t.sidebar.open}
            </button>
          </div>
          {sources.length === 0 && <p className="sidebar-empty">{t.sidebar.noSources}</p>}
          {sources.map((ds) => (
            <div key={ds.id} className={`source-row${activeId === ds.id ? ' selected' : ''}`}>
              <button
                className="item-name"
                onClick={() => onSelect(ds.id)}
                title={ds.sourceFile}
                aria-current={activeId === ds.id ? 'true' : undefined}
              >
                <IconDatabase />
                <span>{ds.displayName}</span>
              </button>
              <button
                className="quiet-button close-source"
                aria-label={`${t.common.close} · ${ds.displayName}`}
                title={t.common.close}
                onClick={() => onClose(ds.id)}
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <section aria-labelledby="snapshots-heading">
          <div className="sidebar-section-head">
            <h2 id="snapshots-heading">{t.sidebar.snapshots}</h2>
          </div>
          <SnapshotList onOpenPreview={onPreview} activeId={activeId} />
        </section>
        <NotebookList onNavigate={onNotebookNavigate} />
      </div>
      {persistent !== null && (
        <footer className={`storage-status${persistent ? '' : ' memory'}`}>
          <span className="status-dot" aria-hidden="true" />
          <span title={persistent ? t.topbar.persistentAvailTooltip : undefined}>
            {persistent
              ? diskAvail
                ? t.topbar.persistentBadgeAvail(diskAvail)
                : t.topbar.persistentBadge
              : t.topbar.memoryBadge}
          </span>
          <WorkspaceSettings />
        </footer>
      )}
      <div
        className="sidebar-divider"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t.sidebar.resize}
        aria-valuemin={200}
        aria-valuemax={Math.min(420, Math.floor(window.innerWidth * 0.42))}
        aria-valuenow={Math.min(width, Math.floor(window.innerWidth * 0.42))}
        onPointerDown={(e) => {
          if (e.button !== 0 || !sidebar.current) return;
          dragOffset.current = sidebar.current.getBoundingClientRect().width - e.clientX;
          widthBeforeDrag.current = width;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const next = e.clientX + dragOffset.current;
          if (next <= 100) {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setWidth(widthBeforeDrag.current);
            setCollapsed(true);
            toggle.current?.focus();
          } else {
            resize(next);
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          resize(
            (sidebar.current?.getBoundingClientRect().width ?? width) +
              (e.key === 'ArrowRight' ? 12 : -12),
          );
        }}
      />
    </aside>
  );
}
