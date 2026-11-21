import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useMessages } from '../../i18n';
import { useUi } from '../../store/ui';
import { IconLink } from '../common/icons';

interface McpInfo {
  port: number;
  url: string | null;
  hasToken: boolean;
  persistent: boolean;
  newToken?: string;
}

const defaultPort = 18476;

export function McpSettings() {
  const t = useMessages().mcp;
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [port, setPort] = useState(String(defaultPort));
  const [visibleToken, setVisibleToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    invoke<McpInfo>('mcp_info').then((value) => {
      if (live) {
        setInfo(value);
        setPort(String(value.port));
      }
    }).catch((err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, []);

  const enabled = !!info?.url;
  const disabled = !info || pending;
  const portNumber = port === '' ? defaultPort : Number(port);
  const validPort = (port === '' || /^\d+$/.test(port)) && portNumber >= 1 && portNumber <= 65535;
  const dirty = info !== null && (port === '' || port !== String(info.port));

  const perform = async (operation: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };

  const savePort = async () => {
    if (!dirty) return;
    if (!validPort) throw new Error(t.invalidPort);
    await invoke('mcp_set_port', { port: portNumber });
    setInfo((value) => value && { ...value, port: portNumber });
    setPort(String(portNumber));
  };

  const toggle = async () => {
    if (!enabled) await savePort();
    const { newToken, ...value } = await invoke<McpInfo>('mcp_set_enabled', { enabled: !enabled });
    setInfo(value);
    setPort(String(value.port));
    setVisibleToken(newToken ?? '');
  };

  const copyConnection = (claudeStdio: boolean) => perform(async () => {
    await invoke('mcp_copy_connection', { claudeStdio });
    useUi.getState().toast('success', t.copied);
  });

  const rotate = async () => {
    if (await confirm(t.regenerateConfirm)) {
      setVisibleToken(await invoke<string>('mcp_regenerate_token'));
    }
  };

  return (
    <section className="mcp-settings" aria-labelledby="mcp-heading">
      <div className="mcp-heading">
        <h3 id="mcp-heading"><IconLink /> MCP</h3>
        <button className="mcp-switch" role="switch" aria-label={t.enable} aria-checked={enabled}
          disabled={disabled || (!enabled && !validPort)} onClick={() => void perform(toggle)}>
          {enabled ? t.on : t.off}<span aria-hidden="true" />
        </button>
      </div>
      <form className="mcp-setting" onSubmit={(e) => { e.preventDefault(); void perform(savePort); }}>
        <label htmlFor="mcp-port">HTTP Port</label>
        <div className="mcp-actions">
          <input id="mcp-port" type="text" inputMode="numeric" autoComplete="off"
            value={port} placeholder={String(defaultPort)} aria-invalid={!validPort}
            aria-describedby={!validPort ? 'mcp-port-error' : undefined}
            disabled={disabled || enabled || !info?.persistent}
            onChange={(e) => setPort(e.target.value)} />
          {dirty && <button className="btn" disabled={disabled || !validPort}>{t.save}</button>}
        </div>
      </form>
      {!validPort && <p className="sql-error" id="mcp-port-error">{t.invalidPort}</p>}
      {info?.url && (
        <div className="mcp-setting"><span>URL</span><code>{info.url}</code></div>
      )}
      <div className="mcp-setting">
        <span>{t.token}</span>
        <div className="mcp-credential">
          {visibleToken ? <code className="mcp-token">{visibleToken}</code> :
            info?.hasToken ? <span aria-label={t.hidden}>••••••••</span> : <span className="mcp-hint">{t.firstEnable}</span>}
          {info?.hasToken && <button className="btn" disabled={disabled} onClick={() => void perform(rotate)}>{t.regenerate}</button>}
        </div>
      </div>
      {enabled && <div className="mcp-actions">
        <button className="btn" disabled={disabled} onClick={() => void copyConnection(false)}>{t.copy}</button>
        <button className="btn" disabled={disabled} onClick={() => void copyConnection(true)}>{t.copyClaude}</button>
      </div>}
      {info && !info.persistent && <p className="mcp-hint">{t.memory}</p>}
      {error && <p className="sql-error" role="alert">{error}</p>}
    </section>
  );
}
