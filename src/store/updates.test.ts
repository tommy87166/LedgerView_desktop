import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { checkUpdate, installUpdate, useUpdates } from './updates';
import { flushNotebook } from './notebooks';
import { useUi } from './ui';
import { waitForRequests } from '../lib/native';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn() }));
vi.mock('../lib/native', () => ({ waitForRequests: vi.fn() }));
vi.mock('./notebooks', () => ({ useNotebooks: { getState: () => ({ books: [{ id: 'one' }] }) }, flushNotebook: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  useUi.setState({ persistent: true, toasts: [] });
  useUpdates.setState({ phase: 'available', version: '1.2.0', error: undefined });
});

it('checks once at startup and notifies only for an available release', async () => {
  useUpdates.setState({ phase: 'idle' });
  vi.mocked(invoke).mockResolvedValue('1.2.0');
  await Promise.all([checkUpdate(true), checkUpdate(true)]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(useUi.getState().toasts).toHaveLength(1);
  vi.mocked(invoke).mockResolvedValue(null);
  await checkUpdate();
  expect(useUpdates.getState().phase).toBe('current');
  expect(useUi.getState().toasts).toHaveLength(1);
});

it('allows a manual retry when the public feed is unavailable', async () => {
  vi.mocked(invoke).mockRejectedValueOnce('Offline').mockResolvedValueOnce(null);
  await checkUpdate();
  expect(useUpdates.getState()).toMatchObject({ phase: 'failed', error: 'Offline' });
  await checkUpdate();
  expect(useUpdates.getState()).toMatchObject({ phase: 'current', error: undefined });
});

it('waits for a verified download and saves the notebook before requesting installation', async () => {
  const order: string[] = [];
  vi.mocked(invoke).mockImplementation(async name => { order.push(name); });
  vi.mocked(flushNotebook).mockImplementation(async () => { order.push('save'); });
  await Promise.all([installUpdate(), installUpdate()]);
  expect(order).toEqual(['download_update', 'save', 'install_update']);
  expect(waitForRequests).toHaveBeenCalledTimes(2);
  expect(flushNotebook).toHaveBeenCalledWith('one');
});

it('stays open after a failed download or save and can retry', async () => {
  vi.mocked(invoke).mockRejectedValueOnce('Invalid signature');
  await installUpdate();
  expect(flushNotebook).not.toHaveBeenCalled();
  vi.mocked(flushNotebook).mockRejectedValueOnce('Disk full');
  await installUpdate();
  expect(useUpdates.getState()).toMatchObject({ phase: 'available', error: 'Disk full' });
  expect(invoke).not.toHaveBeenCalledWith('install_update', expect.anything());
  await installUpdate();
  expect(invoke).toHaveBeenCalledWith('install_update', { version: '1.2.0' });
});

it('lets memory workspace users cancel before downloading', async () => {
  useUi.setState({ persistent: false });
  vi.mocked(confirm).mockResolvedValue(false);
  await installUpdate();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});
