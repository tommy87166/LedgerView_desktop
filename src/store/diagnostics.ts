import { create } from 'zustand';

export interface DiagnosticStatement {
  sql: string;
  params?: string[];
}

export interface DiagnosticEntry {
  token: string;
  operation: string;
  sql?: string;
  currentStatement?: DiagnosticStatement;
  started: number;
  elapsedMs?: number;
  error?: string;
  statements?: DiagnosticStatement[];
}

const preference = 'lv.showDiagnostics';
function readEnabled() {
  try { return localStorage.getItem(preference) === 'true'; }
  catch { return false; }
}

interface Diagnostics {
  enabled: boolean;
  entries: DiagnosticEntry[];
  setEnabled: (enabled: boolean) => void;
  begin: (entry: DiagnosticEntry) => void;
  statement: (token: string, statement: DiagnosticStatement) => void;
  finish: (token: string, elapsedMs: number, statements: DiagnosticStatement[], error?: string) => void;
}

export const useDiagnostics = create<Diagnostics>((set) => ({
  enabled: readEnabled(),
  entries: [],
  setEnabled: (enabled) => {
    try { localStorage.setItem(preference, String(enabled)); } catch { /* Storage unavailable. */ }
    set({ enabled, entries: [] });
  },
  begin: (entry) => set((s) => s.enabled ? { entries: [entry, ...s.entries.slice(0, 99)] } : s),
  statement: (token, currentStatement) => set((s) => {
    const entry = s.entries[0];
    if (entry?.token !== token || entry.elapsedMs !== undefined) return s;
    return { entries: [{ ...entry, currentStatement }, ...s.entries.slice(1)] };
  }),
  finish: (token, elapsedMs, statements, error) => set((s) => {
    const entry = s.entries[0];
    if (entry?.token !== token) return s;
    if (!entry.sql && !statements.length && error === undefined) return { entries: s.entries.slice(1) };
    return { entries: [{ ...entry, elapsedMs, statements, error }, ...s.entries.slice(1)] };
  }),
}));
