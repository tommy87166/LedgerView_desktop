import { useEffect } from 'react';
import { useUi } from '../../store/ui';
import { useMessages } from '../../i18n';

export function Toasts() {
  const t = useMessages();
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1];
    // 錯誤訊息停留較久。
    const ttl = latest.kind === 'error' ? 8000 : 4000;
    const timer = setTimeout(() => dismiss(latest.id), ttl);
    return () => clearTimeout(timer);
  }, [toasts, dismiss]);

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.kind}`}
          onClick={() => dismiss(toast.id)}
          title={t.toast.dismiss}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
