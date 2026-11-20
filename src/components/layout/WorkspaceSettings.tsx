import { useRef } from 'react';
import { LANGS, LANG_NAMES, setLang, useLang, useMessages, type Lang } from '../../i18n';
import { IconSettings } from '../common/icons';

import { RowHeightPicker } from '../grid/RowHeightPicker';
import { useUi } from '../../store/ui';

import { useDiagnostics } from '../../store/diagnostics';

import { McpSettings } from './McpWorkspace';

export function WorkspaceSettings() {
  const t = useMessages();
  const lang = useLang();
  const rowHeight = useUi((s) => s.rowHeight);
  const setRowHeight = useUi((s) => s.setRowHeight);
  const diagnostics = useDiagnostics((s) => s.enabled);
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        className="quiet-button settings-button"
        aria-label={t.sidebar.settings}
        title={t.sidebar.settings}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <IconSettings />
      </button>
      <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-heading">
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
        <label className="workspace-setting">
          {t.diagnostics.setting}
          <input type="checkbox" checked={diagnostics} onChange={(e) => useDiagnostics.getState().setEnabled(e.target.checked)} />
        </label>
        <McpSettings />
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
