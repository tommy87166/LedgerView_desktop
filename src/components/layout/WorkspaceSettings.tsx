import { useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { LANGS, LANG_NAMES, setLang, useLang, useMessages, type Lang } from '../../i18n';
import { IconSettings } from '../common/icons';

import { RowHeightPicker } from '../grid/RowHeightPicker';
import { useUi } from '../../store/ui';

import { useDiagnostics } from '../../store/diagnostics';

import { McpSettings } from './McpSettings';

export function WorkspaceSettings() {
  const t = useMessages();
  const lang = useLang();
  const rowHeight = useUi((s) => s.rowHeight);
  const setRowHeight = useUi((s) => s.setRowHeight);
  const diagnostics = useDiagnostics((s) => s.enabled);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        className="quiet-button settings-button"
        aria-label={t.sidebar.settings}
        title={t.sidebar.settings}
        aria-haspopup="dialog"
        onClick={() => { setOpen(true); dialog.current?.showModal(); }}
      >
        <IconSettings />
      </button>
      <dialog ref={dialog} onClose={() => setOpen(false)} className="settings-dialog" aria-labelledby="settings-heading">
        <header>
          <h2 id="settings-heading">{t.sidebar.settings}</h2>
          <form method="dialog">
            <button className="quiet-button" aria-label={t.common.close}>
              ×
            </button>
          </form>
        </header>
        <label className="workspace-setting">
          {t.lang.label}
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((code) => (
              <option key={code} value={code}>
                {LANG_NAMES[code]}
              </option>
            ))}
          </select>
        </label>
        <RowHeightPicker value={rowHeight} onChange={setRowHeight} />
        <div className="workspace-setting">
          <button
            className="btn"
            disabled={!isTauri()}
            onClick={() => void invoke('open_workspace_directory').catch(error => {
              useUi.getState().toast('error', t.sidebar.openWorkspaceFailed(String(error)));
            })}
          >
            {t.sidebar.openWorkspace}
          </button>
        </div>
        <label className="workspace-setting">
          {t.diagnostics.setting}
          <input type="checkbox" checked={diagnostics} onChange={(e) => useDiagnostics.getState().setEnabled(e.target.checked)} />
        </label>
        {open && <McpSettings />}
        <details>
          <summary>{t.changelog.title}</summary>
          <div className="changelog-entry">
            <strong>v0.1.0</strong>
            <p>{t.changelog.release}</p>
          </div>
        </details>
      </dialog>
    </>
  );
}
