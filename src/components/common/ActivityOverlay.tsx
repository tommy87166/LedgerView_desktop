import { useEffect, useState, useSyncExternalStore } from 'react';
import { cancelQuery, getActivity, subscribe } from '../../lib/native';
import { useMessages } from '../../i18n';

export function ActivityOverlay() {
  const activity = useSyncExternalStore(subscribe, getActivity);
  const [now, setNow] = useState(Date.now);
  const t = useMessages();
  useEffect(() => {
    if (!activity) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [activity]);
  if (!activity || now - activity.started < 500) return null;
  return (
    <div className="query-indicator" role="status">
      <span className="spinner" />
      {activity.label} {Math.floor((now - activity.started) / 1000)}s
      <button className="btn" onClick={() => void cancelQuery(activity.token)}>
        {t.common.cancel}
      </button>
    </div>
  );
}
