import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getMessages } from '../i18n';
import { flushNotebook, useNotebooks } from './notebooks';
import { waitForRequests } from '../lib/native';
import { useUi } from './ui';

type Phase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'saving' | 'installing' | 'failed';
export const useUpdates = create<{ phase: Phase; version?: string; error?: string }>(() => ({ phase: 'idle' }));
export const updating = (phase: Phase) => phase === 'downloading' || phase === 'saving' || phase === 'installing';

export async function checkUpdate(atStartup = false) {
  const { phase } = useUpdates.getState();
  if (!isTauri() || phase === 'checking' || updating(phase) || (atStartup && phase !== 'idle')) return;
  useUpdates.setState({ phase: 'checking', error: undefined, version: undefined });
  try {
    const version = await invoke<string | null>('check_update');
    useUpdates.setState(version ? { phase: 'available', version } : { phase: 'current' });
    if (atStartup && version) useUi.getState().toast('info', getMessages().updates.notice(version));
  } catch (err) {
    useUpdates.setState({ phase: 'failed', error: String(err) });
  }
}

export async function installUpdate() {
  const { phase, version } = useUpdates.getState();
  const { persistent } = useUi.getState();
  if (!version || persistent === null || phase !== 'available') return;
  if (!persistent && !(await confirm(getMessages().updates.memoryWarning))) return;
  if (useUpdates.getState().phase !== 'available') return;
  useUpdates.setState({ phase: 'downloading', error: undefined });
  try {
    await invoke('download_update', { version });
    useUpdates.setState({ phase: 'saving' });
    await waitForRequests();
    for (const book of useNotebooks.getState().books) await flushNotebook(book.id);
    await waitForRequests();
    useUpdates.setState({ phase: 'installing' });
    await invoke('install_update', { version });
  } catch (err) {
    useUpdates.setState({ phase: 'available', error: String(err) });
  }
}
