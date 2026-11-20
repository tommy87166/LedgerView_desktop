import { useEffect, useState } from 'react';
import { useLang, useMessages } from '../../i18n';
import { useDiagnostics, type DiagnosticEntry, type DiagnosticStatement } from '../../store/diagnostics';

function duration(ms: number) {
  return ms < 1000 ? Math.round(Math.max(ms, 0)) + ' ms' : (ms / 1000).toFixed(1) + ' s';
}

function Chevron({ down }: { down?: boolean }) {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d={down ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} stroke="currentColor" strokeWidth="1.5" />
  </svg>;
}

function Parameters({ statement }: { statement: DiagnosticStatement }) {
  const t = useMessages().diagnostics;
  if (!statement.params?.length) return null;
  return <div className="diag-params">
    <span>{t.parameters}</span>
    {statement.params.map((value, index) => <code key={index}>?{index + 1} = {JSON.stringify(value)}</code>)}
  </div>;
}

function LogEntry({ entry, now }: { entry: DiagnosticEntry; now: number }) {
  const t = useMessages().diagnostics;
  const lang = useLang();
  const [expanded, setExpanded] = useState(false);
  const running = entry.elapsedMs === undefined;
  const status = running ? 'running' : entry.error !== undefined ? 'error' : 'done';
  const statements = entry.statements ?? [];
  const summary = entry.sql || entry.currentStatement?.sql || statements[0]?.sql || (running ? t.waiting : entry.operation);
  return <li className="diag-entry">
    <button type="button" className="diag-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <time>{new Date(entry.started).toLocaleTimeString(lang, { hour12: false })}</time>
      <span className={'diag-status ' + status}>{entry.operation === 'MCP' && 'MCP · '}{t[status]}</span>
      <span className="diag-duration">{duration(entry.elapsedMs ?? now - entry.started)}</span>
      <code>{summary}</code>
      <Chevron down={expanded} />
    </button>
    {running && entry.currentStatement && entry.sql && entry.currentStatement.sql !== entry.sql &&
      <div className="diag-current"><span>{t.engineSql}</span> <code>{entry.currentStatement.sql}</code></div>}
    {running && entry.currentStatement && <Parameters statement={entry.currentStatement} />}
    {entry.error !== undefined && <pre className="diag-error">{entry.error}</pre>}
    {expanded && <div className="diag-detail">
      {entry.sql && <><strong>{t.submitted}</strong><pre>{entry.sql}</pre></>}
      {statements.length > 0 ? <><strong>{t.engineSql}</strong><ol>{statements.map((stmt, i) => <li key={i}><pre>{stmt.sql}</pre><Parameters statement={stmt} /></li>)}</ol></>
        : running && <pre>{entry.currentStatement?.sql || t.waiting}</pre>}
    </div>}
  </li>;
}

function LogPanel() {
  const entries = useDiagnostics(s => s.entries);
  const t = useMessages().diagnostics;
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(Date.now);
  const runningToken = entries.find(e => e.elapsedMs === undefined)?.token;
  useEffect(() => {
    if (!runningToken || !expanded) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, [runningToken, expanded]);
  return <section className="diag-panel" aria-label={t.title}>
    <button className="diag-toggle" type="button" aria-controls="diag-content" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.45">
        <rect x="2" y="3.5" width="16" height="13" rx="2" /><path d="m5 7 3 3-3 3m5 0h4"/>
      </svg>
      <strong>{t.title}</strong>
      {entries.length > 0 && <span className="diag-count">{entries.length}</span>}
      <span className={'diag-fold' + (expanded ? ' up' : '')}><Chevron down /></span>
    </button>
    <div id="diag-content" hidden={!expanded}>
      {entries.length === 0 ? <p className="diag-empty">{t.empty}</p> : <>
        <div className="diag-head"><span>{t.time}</span><span>{t.status}</span><span>{t.duration}</span><span>SQL</span></div>
        <ol className="diag-entries">{entries.map(entry => <LogEntry key={entry.token} entry={entry} now={now} />)}</ol>
      </>}
    </div>
  </section>;
}

export function DiagnosticLog() {
  return useDiagnostics(s => s.enabled) ? <LogPanel /> : null;
}
