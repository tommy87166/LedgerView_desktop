import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { version as installed } from '../../../package.json';
import { checkUpdate, installUpdate, updating, useUpdates } from '../../store/updates';
import { useMessages } from '../../i18n';

export function UpdateSettings() {
  const t = useMessages().updates;
  const { phase, version, error } = useUpdates();
  return (
    <section aria-label={t.title}>
      <div className="workspace-setting">
        <span>{t.title} · {installed}</span>
        {version
          ? <button className="btn" disabled={updating(phase)} onClick={() => void installUpdate()}>{t.install(version)}</button>
          : <button className="btn" disabled={!isTauri() || phase === 'checking'} onClick={() => void checkUpdate()}>
            {phase === 'checking' ? t.checking : t.check}
          </button>}
      </div>
      {phase === 'current' && <p role="status">{t.current}</p>}
      {error && <p className="sql-error" role="alert">{phase === 'failed' ? t.checkFailed : t.installFailed} {error}</p>}
    </section>
  );
}

// Keep user edits out of the save/restart window, including when settings is remounted.
export function UpdateProgress() {
  const phase = useUpdates(s => s.phase);
  const dialog = useRef<HTMLDialogElement>(null);
  const t = useMessages().updates;
  const busy = updating(phase);
  useEffect(() => {
    if (busy) dialog.current?.showModal();
    else dialog.current?.close();
  }, [busy]);
  return <dialog className="settings-dialog" ref={dialog} aria-label={t.title} onCancel={e => e.preventDefault()}>
    <p role="status">{phase === 'downloading' ? t.downloading : phase === 'saving' ? t.saving : t.installing}</p>
  </dialog>;
}
