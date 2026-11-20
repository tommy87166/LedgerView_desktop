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
    const entry = s.entries.find(e => e.token === token);
    if (!entry || entry.elapsedMs !== undefined) return s;
    return { entries: s.entries.map(e => e === entry ? { ...e, currentStatement } : e) };
  }),
  finish: (token, elapsedMs, statements, error) => set((s) => {
    const entry = s.entries.find(e => e.token === token);
    if (!entry) return s;
    if (!entry.sql && !statements.length && error === undefined) return { entries: s.entries.filter(e => e !== entry) };
    return { entries: s.entries.map(e => e === entry ? { ...e, elapsedMs, statements, error } : e) };
  }),
}));
