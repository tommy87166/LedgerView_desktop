// 繁體中文語系（canonical）：定義 Messages / GridLocale 型別形狀，英文語系須對齊此結構。
// AG Grid localeText（覆蓋常用的篩選、選單、狀態字串）。
export const GRID_ZH_TW = {
  // 數字 / 文字 / 日期篩選器
  equals: '等於',
  notEqual: '不等於',
  blank: '空白',
  notBlank: '非空白',
  empty: '請選擇',
  lessThan: '小於',
  greaterThan: '大於',
  lessThanOrEqual: '小於或等於',
  greaterThanOrEqual: '大於或等於',
  inRange: '介於',
  inRangeStart: '從',
  inRangeEnd: '到',
  contains: '包含',
  notContains: '不包含',
  startsWith: '開頭為',
  endsWith: '結尾為',
  before: '早於',
  after: '晚於',

  // 篩選器面板
  andCondition: '且 (AND)',
  orCondition: '或 (OR)',
  applyFilter: '套用',
  resetFilter: '重設',
  clearFilter: '清除',
  cancelFilter: '取消',
  filterOoo: '篩選…',
  searchOoo: '搜尋…',
  selectAll: '(全選)',
  noMatches: '沒有符合項目',

  // 欄位選單
  pinColumn: '釘選欄位',
  pinLeft: '釘選到左側',
  pinRight: '釘選到右側',
  noPin: '取消釘選',
  autosizeThisColumn: '自動調整此欄寬',
  autosizeAllColumns: '自動調整所有欄寬',
  resetColumns: '重設欄位',

  // 一般
  loadingOoo: '載入中…',
  noRowsToShow: '沒有資料',
  page: '頁',
  to: '至',
  of: '／',
  totalRows: '總列數',
  totalAndFilteredRows: '列數',
};

// 應用層字串。
export const MESSAGES_ZH_TW = {
  appName: 'LedgerView',
  langName: '繁體中文',

  common: {
    close: '關閉',
    cancel: '取消',
    none: '（無）',
    blank: '(空白)',
  },

  lang: {
    label: '語言',
  },

  app: {
    initializing: '正在初始化資料庫引擎…',
    dbInitFailed: '資料庫初始化失敗：',
    reopenFailed: (name: string) => `「${name}」重新開啟失敗，請重新匯入該 Parquet。`,
  },

  topbar: {
    openFileTooltip: '選擇一或多個 Parquet 檔案',
    persistentBadge: '磁盤模式（保存進度）',
    persistentBadgeAvail: (avail: string) => `磁盤模式［可用 ${avail}］（保存進度）`,
    persistentAvailTooltip: '本機快照與查詢暫存檔的可用磁碟空間',
    memoryBadge: '記憶體模式（不保存進度）',
    importing: '匯入中…',
    createSnapshot: '快照',
    createSnapshotTooltip: '以目前的篩選與排序建立快照',
    columns: '欄位',
    columnsTooltip: '顯示／隱藏欄位（僅此資料表）',
  },

  updates: {
    title: '程式更新',
    check: '檢查更新',
    checking: '檢查中…',
    current: '已是最新版。',
    downloading: '正在下載並驗證更新檔…',
    saving: '正在儲存筆記本並等候工作完成…',
    installing: '正在安裝，稍後將重新啟動…',
    checkFailed: '無法檢查更新。',
    installFailed: '更新未完成。',
    memoryWarning: '目前是記憶體模式。重新啟動會清除這次工作階段的資料。若要保留，請先取消並匯出筆記本或快照。現在更新並重新啟動嗎？',
    install: (v: string) => `更新至 ${v} 並重新啟動`,
    notice: (v: string) => `已有新版 ${v} 可在設定中更新。`,
  },
  changelog: {
    title: '更新紀錄',
    release: '新增 GitHub 版本檢查與簽章更新，可從設定安裝新版並重新啟動。',
  },

  mcp: {
    copyTemplate: '複製 HTTP 範本',
    copyClaude: '複製 Claude Desktop 設定（stdio）',
    enable: '啟用本機 MCP', on: '開啟', off: '關閉', save: '儲存',
    invalidPort: '請輸入 1 至 65535 的整數，留白使用 18476。',
    token: 'HTTP 權杖', firstEnable: '首次開啟時產生', hidden: '權杖已隱藏', regenerate: '重新產生',
    regenerateConfirm: '重新產生權杖後，現有用戶端需要更新連線設定。要繼續嗎？',
    memory: '記憶體模式使用預設連接埠，權杖只保留到程式關閉。',
    copy: '複製 HTTP 設定', copied: '已複製連線設定', preview: '預覽',
  },
  diagnostics: {
    title: '診斷日誌',
    setting: '顯示診斷日誌',
    resize: '調整診斷日誌高度',
    empty: '勾選後執行的 SQL 會顯示在這裡。',
    time: '時間',
    status: '狀態',
    duration: '操作耗時',
    running: '執行中',
    done: '完成',
    error: '錯誤',
    parameters: '綁定參數',
    engineSql: '引擎 SQL',
    waiting: '等待引擎回報 SQL…',
    submitted: '原始 SQL',
  },

  notebook: {
    title: '筆記本',
    newBook: '新增',
    newCell: '＋ SQL 區塊',
    cell: '查詢',
    name: '筆記本名稱',
    open: '開啟筆記本',
    export: '匯出',
    create: '新增筆記本',
    cellName: 'SQL 區塊名稱',
    resizeEditor: '調整 SQL 編輯區高度',
    deleteCell: '刪除 SQL 區塊',
    deleteCellConfirm: (name: string) => `刪除 SQL 區塊「${name}」？`,
    saved: '已儲存',
    saving: '儲存中…',
    saveFailed: '儲存失敗 · 重試',
    memory: '已存於記憶體',
    run: '執行',
    runSnapshot: '執行並快照',
    running: '執行中…',
    placeholder: '輸入 DuckDB SQL…（Ctrl+Space 顯示建議）',
    database: '資料庫',
    snapshot: '快照',
    sources: '可查詢的資料表',
    rows: '列',
    prev: '上一頁',
    next: '下一頁',
    delete: '刪除筆記本',
    delConfirm: '刪除這本筆記本？',
    exported: '已匯出筆記本',
    openError: '無法開啟筆記本',
    fileType: 'LedgerView 筆記本',
    snapCreated: '已建立快照',
    stale: 'SQL 已修改，請重新執行',
  },
  sidebar: {
    storageMode: '儲存模式',
    title: '來源',
    databases: '資料庫',
    snapshots: '快照',
    settings: '設定',
    openWorkspace: '開啟工作目錄',
    openWorkspaceFailed: (error: string) => `無法開啟工作目錄：${error}`,
    open: '開啟',
    noSources: '尚未開啟資料庫',
    resize: '調整來源面板寬度',
    collapse: '收合來源面板',
    expand: '展開來源面板',
  },

  empty: {
    hint: '選擇或拖入 Parquet 檔案檢視資料。',
  },

  status: {
    clearAll: '清除篩選與排序',
    clearAllTooltip: '一鍵清除所有欄位的篩選與排序',
    rows: '列',
    filteredRows: '篩選後',
    aggColumn: '彙總欄位：',
    sum: '合計',
    avg: '平均',
    count: '筆數',
    columnCount: (n: number) => `${n} 欄`,
  },

  snapshot: {
    emptyLine1: '尚無快照。',
    sourcePrefix: '來源：',
    noFilter: '無篩選',
    rows: (n: string) => `${n} 列`,
    closePreview: '關閉快照預覽',
    copy: '複製',
    rename: '重新命名',
    delete: (name: string) => `刪除快照「${name}」`,
    downloadExcel: '匯出 Excel',
    downloadParquet: '下載 Parquet',
    created: (name: string, rows: string) => `已建立快照「${name}」（${rows} 列）`,
    createFailed: (msg: string) => `建立快照失敗：${msg}`,
    openFailed: (msg: string) => `開啟快照失敗：${msg}`,
    copied: '已複製到剪貼簿',
    copyFailed: (msg: string) => `複製失敗：${msg}`,
    downloadFailed: (msg: string) => `下載失敗：${msg}`,
    deleteConfirm: (name: string) => `刪除快照「${name}」？`,
    deleteFailed: (msg: string) => `刪除失敗：${msg}`,
    renameFailed: (msg: string) => `改名失敗：${msg}`,
    dataTooLarge: '資料量過大',
    copyTooLarge: (cells: string) => `資料量過大（約 ${cells} 格），請改用下載。`,
    copyWarn: '這份快照較大，確定要複製到剪貼簿？',
  },

  dataset: {
    closeConfirm: (name: string) => `關閉「${name}」？`,
    closed: (name: string) => `已關閉「${name}」`,
    closeFailed: (msg: string) => `關閉失敗：${msg}`,
  },

  toast: {
    dismiss: '點擊關閉',
  },

  columns: {
    title: '顯示欄位',
    showAll: '全顯示',
    hideAll: '全隱藏',
  },

  cellMenu: {
    copyValue: '複製值',
    filterBy: (colId: string) => `以此值篩選「${colId}」`,
    copyArray: '複製成不重複陣列',
  },

  rowHeight: {
    title: '行距',
    compact: '緊湊',
    standard: '標準',
    relaxed: '寬鬆',
    wide: '特寬',
  },

  grid: {
    queryFailed: (msg: string) => `查詢失敗：${msg}`,
    copied: '已複製',
    copyFailed: '複製失敗',
    copiedArray: (n: number) => `已複製 ${n} 個值為不重複陣列`,
    copyArrayFailed: '複製陣列失敗',
  },

  filter: {
    modeList: '清單',
    modeText: '文字條件',
    modeArray: '已複製的陣列',
    backToList: '← 回到清單',
    switchTo: (label: string) => `改用${label}`,
    arrayLoadedPre: '已從剪貼簿讀取，已選取 ',
    arrayLoadedPost: ' 個值（按「套用」執行 OR 篩選）。',
    arrayFormatError: '剪貼簿格式不符，需為 {"selected":[...]}',
    arrayReadError: '無法讀取剪貼簿或解析失敗（請先用右鍵「複製成陣列」）',
    arrayReading: '讀取剪貼簿中…',
    reread: '重新讀取剪貼簿',
    noSecondCondition: '（不加第二條件）',
    selectToggle: '全選／取消以下項目',
    selectedCount: (n: number) => `（已選 ${n} 個）`,
    truncated: (limit: number) => `值過多，僅載入前 ${limit} 個（搜尋僅及於這些）。`,
  },

  import: {
    imported: (name: string, n: string) => `已匯入「${name}」（${n} 列）`,
    unsupportedFormat: (name: string) => `請選擇 Parquet 檔案（${name}）`,
    oversizeConfirm: (name: string, size: string, limit: string) =>
      `「${name}」大小 ${size} 超過建議上限 ${limit}，匯入可能很慢或失敗，仍要繼續嗎？`,
    processFailed: (name: string, msg: string) => `處理「${name}」失敗：${msg}`,
  },

  activity: {
    query: '查詢中',
    importing: '匯入中',
  },
};

export type Messages = typeof MESSAGES_ZH_TW;
export type GridLocale = typeof GRID_ZH_TW;
