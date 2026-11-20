// English locale. Mirrors the structure of the canonical zh-TW locale.
import type { GridLocale, Messages } from './zh-TW';

export const GRID_EN: GridLocale = {
  // Number / text / date filters
  equals: 'Equals',
  notEqual: 'Not equal',
  blank: 'Blank',
  notBlank: 'Not blank',
  empty: 'Choose one',
  lessThan: 'Less than',
  greaterThan: 'Greater than',
  lessThanOrEqual: 'Less than or equal',
  greaterThanOrEqual: 'Greater than or equal',
  inRange: 'In range',
  inRangeStart: 'From',
  inRangeEnd: 'To',
  contains: 'Contains',
  notContains: 'Not contains',
  startsWith: 'Starts with',
  endsWith: 'Ends with',
  before: 'Before',
  after: 'After',

  // Filter panel
  andCondition: 'AND',
  orCondition: 'OR',
  applyFilter: 'Apply',
  resetFilter: 'Reset',
  clearFilter: 'Clear',
  cancelFilter: 'Cancel',
  filterOoo: 'Filter…',
  searchOoo: 'Search…',
  selectAll: '(Select all)',
  noMatches: 'No matches',

  // Column menu
  pinColumn: 'Pin column',
  pinLeft: 'Pin left',
  pinRight: 'Pin right',
  noPin: 'No pin',
  autosizeThisColumn: 'Autosize this column',
  autosizeAllColumns: 'Autosize all columns',
  resetColumns: 'Reset columns',

  // General
  loadingOoo: 'Loading…',
  noRowsToShow: 'No rows to show',
  page: 'Page',
  to: 'to',
  of: 'of',
  totalRows: 'Total rows',
  totalAndFilteredRows: 'Rows',
};

export const MESSAGES_EN: Messages = {
  appName: 'LedgerView',
  langName: 'English',

  common: {
    close: 'Close',
    cancel: 'Cancel',
    none: '(none)',
    blank: '(blank)',
  },

  lang: {
    label: 'Language',
  },

  app: {
    initializing: 'Initializing database engine…',
    dbInitFailed: 'Database initialization failed:',
    reopenFailed: (name: string) =>
      `Failed to reopen "${name}". Please re-import the Parquet file.`,
  },

  topbar: {
    openFileTooltip: 'Select one or more Parquet files',
    persistentBadge: 'Disk mode (progress saved)',
    persistentBadgeAvail: (avail: string) => `Disk mode [${avail} free] (progress saved)`,
    persistentAvailTooltip: 'Free disk space for snapshots and temporary query data',
    memoryBadge: 'Memory mode (progress not saved)',
    importing: 'Importing…',
    createSnapshot: 'Snapshot',
    createSnapshotTooltip: 'Create a snapshot from the current filters and sorting',
    columns: 'Columns',
    columnsTooltip: 'Show / hide columns (this table only)',
  },

  changelog: {
    title: 'Changelog',
    release:
      'Browse local Parquet files, filter across ledgers, save snapshots and export Parquet.',
  },

  notebook: {
    title: 'Notebooks',
    newBook: 'New',
    newCell: '+ SQL cell',
    cell: 'Query',
    name: 'Notebook name',
    open: 'Open notebook',
    export: 'Export',
    create: 'New notebook',
    cellName: 'SQL cell name',
    deleteCell: 'Delete SQL cell',
    deleteCellConfirm: (name: string) => `Delete SQL cell “${name}”?`,
    saved: 'Saved',
    saving: 'Saving…',
    saveFailed: 'Save failed · Retry',
    memory: 'Saved in memory',
    run: 'Run',
    runSnapshot: 'Run and snapshot',
    running: 'Running…',
    placeholder: 'Enter SQL…',
    sources: 'Available tables',
    rows: 'rows',
    prev: 'Previous page',
    next: 'Next page',
    delete: 'Delete notebook',
    delConfirm: 'Delete this notebook?',
    exported: 'Notebook exported',
    openError: 'Could not open notebook',
    fileType: 'LedgerView notebook',
    snapCreated: 'Snapshot created',
    stale: 'SQL changed. Run again to update.',
  },
  sidebar: {
    title: 'Sources',
    databases: 'Databases',
    snapshots: 'Snapshots',
    settings: 'Settings',
    open: 'Open',
    noSources: 'No databases open',
    resize: 'Resize Sources panel',
    collapse: 'Collapse Sources panel',
    expand: 'Expand Sources panel',
  },

  empty: {
    hint: 'Open or drop Parquet files to view a ledger.',
  },

  status: {
    clearAll: 'Clear filters & sorting',
    clearAllTooltip: 'Clear all column filters and sorting at once',
    rows: 'Rows',
    filteredRows: 'Filtered',
    aggColumn: 'Aggregate column:',
    sum: 'Sum',
    avg: 'Avg',
    count: 'Count',
    columnCount: (n: number) => `${n} columns`,
  },

  snapshot: {
    emptyLine1: 'No snapshots yet.',
    sourcePrefix: 'Source: ',
    noFilter: 'No filter',
    rows: (n: string) => `${n} rows`,
    closePreview: 'Close snapshot preview',
    copy: 'Copy',
    rename: 'Rename',
    delete: (name: string) => `Delete snapshot "${name}"`,
    downloadParquet: 'Download Parquet',
    created: (name: string, rows: string) => `Created snapshot "${name}" (${rows} rows)`,
    createFailed: (msg: string) => `Failed to create snapshot: ${msg}`,
    openFailed: (msg: string) => `Failed to open snapshot: ${msg}`,
    copied: 'Copied to clipboard',
    copyFailed: (msg: string) => `Copy failed: ${msg}`,
    downloadFailed: (msg: string) => `Download failed: ${msg}`,
    deleteConfirm: (name: string) => `Delete snapshot "${name}"?`,
    deleteFailed: (msg: string) => `Delete failed: ${msg}`,
    renameFailed: (msg: string) => `Rename failed: ${msg}`,
    dataTooLarge: 'Data too large',
    copyTooLarge: (cells: string) =>
      `Data too large (about ${cells} cells); please download instead.`,
    copyWarn: 'This is a large snapshot. Copy it to the clipboard?',
  },

  dataset: {
    closeConfirm: (name: string) => `Close "${name}"?`,
    closed: (name: string) => `Closed "${name}"`,
    closeFailed: (msg: string) => `Close failed: ${msg}`,
  },

  toast: {
    dismiss: 'Click to dismiss',
  },

  columns: {
    title: 'Show columns',
    showAll: 'Show all',
    hideAll: 'Hide all',
  },

  cellMenu: {
    copyValue: 'Copy value',
    filterBy: (colId: string) => `Filter "${colId}" by this value`,
    copyArray: 'Copy as distinct array',
  },

  rowHeight: {
    title: 'Row height',
    compact: 'Compact',
    standard: 'Standard',
    relaxed: 'Relaxed',
    wide: 'Wide',
  },

  grid: {
    queryFailed: (msg: string) => `Query failed: ${msg}`,
    copied: 'Copied',
    copyFailed: 'Copy failed',
    copiedArray: (n: number) => `Copied ${n} values as a distinct array`,
    copyArrayFailed: 'Failed to copy array',
  },

  filter: {
    modeList: 'List',
    modeText: 'Text condition',
    modeArray: 'Copied array',
    backToList: '← Back to list',
    switchTo: (label: string) => `Switch to ${label}`,
    arrayLoadedPre: 'Loaded from clipboard, selected ',
    arrayLoadedPost: ' value(s) (click "Apply" to run an OR filter).',
    arrayFormatError: 'Clipboard format mismatch, expected {"selected":[...]}',
    arrayReadError:
      'Could not read or parse the clipboard (use right-click "Copy as distinct array" first)',
    arrayReading: 'Reading clipboard…',
    reread: 'Re-read clipboard',
    noSecondCondition: '(no second condition)',
    selectToggle: 'Select / deselect the items below',
    selectedCount: (n: number) => `(${n} selected)`,
    truncated: (limit: number) =>
      `Too many values; only the first ${limit} are loaded (search applies to these only).`,
  },

  import: {
    imported: (name: string, n: string) => `Imported "${name}" (${n} rows)`,
    unsupportedFormat: (name: string) => `Select a Parquet file (${name})`,
    oversizeConfirm: (name: string, size: string, limit: string) =>
      `"${name}" is ${size}, exceeding the recommended limit of ${limit}. Import may be slow or fail. Continue anyway?`,
    processFailed: (name: string, msg: string) => `Failed to process "${name}": ${msg}`,
  },

  activity: {
    query: 'Querying',
    importing: 'Importing',
  },
};
