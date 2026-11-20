import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
// UI 字體：IBM Plex Sans（Latin/數字），CJK 由 system fallback。
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import { App } from './App';
import './styles.css';

// AG Grid v34+：以模組註冊啟用功能。AllCommunityModule 已含 Infinite Row Model 與
// 內建文字／數字／日期篩選器。
ModuleRegistry.registerModules([AllCommunityModule]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
