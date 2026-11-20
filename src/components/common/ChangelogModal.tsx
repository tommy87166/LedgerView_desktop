import { useEffect } from 'react';
import { useMessages } from '../../i18n';

/** 顯示完整更新紀錄的對話框（沿用既有 .modal 樣式）。 */
export function ChangelogModal({ onClose }: { onClose: () => void }) {
  const t = useMessages();
  // Esc 關閉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t.changelog.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">{t.changelog.title}</div>
        <div className="modal-body">
          <div className="changelog">
            <section className="changelog-entry">
              <div className="changelog-head">
                <span className="changelog-version">v0.1.0</span>
              </div>
              <p>{t.changelog.release}</p>
            </section>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}
