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
    switchTooltip: 'Switch interface language (繁體中文 / English)',
  },

  app: {
    initializing: 'Initializing database engine…',
    dbInitFailed: 'Database initialization failed:',
    reopenFailed: (name: string) =>
      `Failed to reopen "${name}". Please re-import the Parquet file.`,
  },

  topbar: {
    openFile: 'Open file',
    openFileTooltip: 'Select one or more Parquet files',
    persistentBadge: 'Disk mode (progress saved)',
    persistentBadgeAvail: (avail: string) => `Disk mode [${avail} free] (progress saved)`,
    persistentAvailTooltip: 'Free disk space for snapshots and temporary query data',
    memoryBadge: 'Memory mode (progress not saved)',
    importing: 'Importing…',
    createSnapshot: 'Snapshot',
    createSnapshotTooltip: 'Create a snapshot from the current filters and sorting',
    columns: 'Columns',
    columnsTooltip: 'Show / hide columns (this tab only)',
    rowHeight: 'Row height',
    rowHeightTooltip: 'Adjust row height (global)',
    manageSnapshot: 'Snapshots',
    manageSnapshotTooltip: 'Open / close snapshot manager',
    changelog: 'Changelog',
    changelogTooltip: 'View changelog',
  },

  changelog: {
    title: 'Changelog',
    release:
      'Browse local Parquet files, filter across ledgers, save snapshots and export Parquet.',
  },

  tabs: {
    snapshot: 'Snapshot',
    snapshotPreview: 'Snapshot preview',
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
    paneTitle: 'Snapshots',
    resizeTooltip: 'Drag to resize',
    closeTooltip: 'Close snapshot panel',
    emptyLine1: 'No snapshots yet.',
    emptyLine2: (createLabel: string) =>
      `Open a file, apply filters and sorting, then click "${createLabel}" in the toolbar to create one.`,
    sourcePrefix: 'Source: ',
    noFilter: 'No filter',
    rows: (n: string) => `${n} rows`,
    openPreviewTooltip: 'Click to open as a preview tab',
    copy: 'Copy to clipboard',
    rename: 'Rename',
    delete: 'Delete',
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
