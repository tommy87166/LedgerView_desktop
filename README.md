<p align="center"><img src="public/favicon.svg" width="76" alt="LedgerView" /></p>
<h1 align="center">LedgerView</h1>
<p align="center">Query local Parquet ledgers, review the results, and save snapshots to Excel or Parquet.</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/DuckDB-2.0.0-fff000" alt="DuckDB 2.0.0" />
  <a href="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml"><img src="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml/badge.svg" alt="Desktop CI" /></a>
</p>
<p align="center"><a href="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml">Windows x64 · macOS Apple Silicon</a></p>
<p align="center"><b>English</b> | <a href="README.zh-TW.md">繁體中文</a></p>

---

## 💡 Why LedgerView

Follow a voucher across multiple Parquet files, check totals for a filtered set of entries, and keep the rows behind a reconciliation. Use the grid for interactive review or a SQL notebook for queries you want to run again.

## 📦 Download

Open a successful run of the desktop workflow and download the build from **Artifacts**. [Desktop builds](https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml)

| Platform | Artifact | Run |
| --- | --- | --- |
| Windows x64 | `LedgerView.exe` | Open the executable. The desktop UI uses the Microsoft Edge WebView2 Runtime. |
| macOS Apple Silicon | `LedgerView-macOS-arm64.app.zip` | Unzip and open `LedgerView.app`. The app is ad hoc signed and has no Apple notarization. |

## 🔧 How it works

1. **Open data.** Drag Parquet files into the window or choose **Databases → Open**. DuckDB reads the original files in place. Click a column header to sort, Shift-click to add a sort, or use the column filter to narrow the rows. Copy distinct voucher numbers from one text column and apply that list as a filter in another file.
2. **Keep a snapshot.** Choose the columns and sort order, then click **Snapshot**. The saved rows stay available when you close the source. The snapshot list offers **Download Parquet** and **Export Excel**.
3. **Work in SQL.** Create a notebook in the sidebar. Add named SQL cells, use Ctrl+Space for table and column suggestions, and run a cell with Ctrl+Enter or ⌘+Enter. Results appear beneath the cell. **Run & Snapshot** saves the full result. Notebooks autosave and can be shared as `.lvnb.json` files.

| Data | Storage |
| --- | --- |
| Registered sources | Original Parquet files, queried by path. |
| Saved snapshots and notebooks | The workspace's `ledger.duckdb`. Open its folder from Settings. In memory mode, changes last for the session. |
| MCP query results | Temporary local Parquet files. Each result can use up to 2 GiB. The cache retains up to eight results within 8 GiB and evicts the oldest result available when space is needed. Saved snapshots remain in the workspace. Stopping MCP or closing the app removes the cache. The next launch cleans up any interrupted session. |

**Excel export.** Each sheet holds up to 1,048,575 data rows plus a header. Further rows continue on a new sheet in snapshot order. Numeric cells and supported dates can be used in calculations. Text IDs retain their leading zeros, integers and fixed-point decimals exceeding 15 significant digits are written as text, and timestamps retain their precision as text. An export that exceeds Excel's column or cell-text limits reports an error and preserves any existing destination file.

## 🤖 Connect an AI client

Open **Settings → MCP** and enable the local service. Keep LedgerView running while the client uses it. A connected client can read every registered source and snapshot and edit notebooks across the workspace. Query results returned to a client are available to that client.

**Claude Desktop (stdio)**

1. Install LedgerView in its intended location, then choose **Copy Claude Desktop config (stdio)** in MCP settings.
2. In Claude Desktop, open **Settings → Developer → Edit Config**. Merge the copied `LedgerView` entry into `mcpServers`, or paste the complete JSON if the file is empty.
3. Quit and reopen Claude Desktop. Ask Claude to list the tables in your LedgerView workspace.

Claude launches the same executable with `--mcp-stdio`. It connects to the open desktop workspace through a Unix socket on macOS or a local named pipe on Windows. Access is limited to processes running as your OS user while MCP is enabled. The Claude configuration contains only the executable path and arguments. If upgrading from the HTTP-backed bridge, replace the old entry to remove its saved token. Copy the configuration again if you move the executable. [MCP local server setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

**Streamable HTTP.** The default URL is `http://127.0.0.1:18476/mcp`. Change the port while MCP is off. Disk workspaces store the port and a SHA-256 hash of the bearer token. Existing credentials are migrated on opening the workspace. Copy the full HTTP settings when generating or rotating the token. Later, **Copy HTTP template** copies a placeholder for your saved token. Rotation immediately revokes the previous token.

| Tool | Use |
| --- | --- |
| `list_sources` | Get the SQL aliases, column names, and types for open sources and snapshots. |
| `query` | Run read-only DuckDB SQL. Return a page to the client, or use `preview: true` to open the result on the desktop. |
| `result_page` | Read subsequent pages using the returned cursor. |
| `save_snapshot` | Save the complete result, optionally open it, or replace a snapshot previously created from an AI result. |
| `export_excel` | Write an entire snapshot or query result to an Excel workbook. Supply `snapshotId` or `resultId` and optionally a `fileName` such as `summary.xlsx`. Files are saved directly in the workspace directory and existing files are preserved. |
| `list_notebooks` | Read notebook names, cells, SQL, and revisions. |
| `edit_notebook` | Create or edit notebooks. Revision checks detect concurrent edits. If the desktop applies an edit and the disk save fails, the tool reports the draft as applied and pending save. |

To inspect a query, enable the diagnostic log in Settings. It shows the SQL, bound values, elapsed time, and errors.

## 🛠️ Development

Install Node.js, Rust, and the Tauri prerequisites for your platform. The first Rust build compiles bundled DuckDB 2.0.0 and its Parquet support from C++. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri -- dev
```

```sh
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

## 📊 Verification

Frontend tests cover table filters, paging, notebooks, and the desktop bridge. Rust tests use synthetic Parquet data and real DuckDB queries to exercise sorting, precision, persistence, Excel and Parquet round trips, authorization, and MCP notebook edits. The Windows and macOS workflows run the stdio query test through the packaged executable.

## 🗂️ Code layout

| Directory | Responsibility |
| --- | --- |
| `src/components/` | React grid, snapshots, SQL notebooks, and workspace controls. |
| `src-tauri/src/` | Tauri commands, DuckDB workspace, filters, notebook execution, and snapshot export. |
| `src-tauri/src/mcp/` | MCP tools, HTTP service, stdio bridge, authentication, and temporary results. |

MIT licensed. [License](LICENSE)

### App updates

Starting with 1.1.0, LedgerView checks this repository’s latest GitHub Release after opening the workspace. Open **Settings → App updates** to check again or install a new version. The app verifies the download and its signed version, saves pending notebook edits, replaces the portable Windows executable or macOS app in place, and restarts. Disk workspaces keep their catalog. Export anything you want to keep from a memory workspace before restarting.

The feed requires anonymous read access. Users of 1.0.0 need to upgrade manually once. To publish an update, push a numeric tag matching the app version. After both platform jobs pass, CI signs the packages with the `LEDGERVIEW_UPDATE_SIGNING_KEY` Actions secret, verifies them against the embedded public key, and publishes them with `latest.json`. Branch and PR builds exercise updates with temporary test keys.
