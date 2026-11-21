<p align="center"><img src="public/favicon.svg" width="76" alt="LedgerView" /></p>
<h1 align="center">LedgerView</h1>
<p align="center">在桌面查詢 Parquet 明細帳，將篩選或 SQL 結果保留成快照。</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/DuckDB-2.0.0-fff000" alt="DuckDB 2.0.0" />
  <a href="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml"><img src="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml/badge.svg" alt="Desktop CI" /></a>
</p>
<p align="center"><a href="https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml">Windows x64 · macOS Apple Silicon</a></p>
<p align="center"><a href="README.md">English</a> | <b>繁體中文</b></p>

---

LedgerView 在本機開啟 Parquet 明細帳，沿用 LedgerView Web 0.8.0 的表格操作。可以從科目明細複製傳票號清單，切到完整分錄查出對應項目，核對金額，再留存工作底稿。[線上版](https://ledgerview.pages.dev/) · [Web 版功能盤點](docs/ledgerview-web-features.md)

## 📦 從 GitHub 下載桌面版

推送到 `main`、向 `main` 提出 pull request，或手動執行工作流程時，GitHub Actions 會在 Windows 和 macOS 各自建置桌面版並執行前端與 Rust 測試。開啟成功的執行紀錄，在 **Artifacts** 下載對應平台的檔案。[桌面版 CI](https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml)

| 平台 | 下載檔 | 使用方式 |
| --- | --- | --- |
| Windows x64 | `LedgerView.exe` | 直接執行。DuckDB 已編入執行檔，介面使用系統的 Microsoft Edge WebView2 Runtime。 |
| macOS Apple Silicon | `LedgerView-macOS-arm64.app.zip` | 解壓縮後開啟 `LedgerView.app`。此版本使用 ad hoc 簽章，尚未通過 Apple 公證。 |

## 💡 開始使用

1. 在左側「資料庫」旁按「開啟」選取一或多個 `.parquet`，也可以直接拖入視窗。點選側欄中的檔名即可切換右側表格。程式記住原始路徑，重開時會再次讀取該檔案。
2. 點欄名排序，按住 Shift 可加入第二個排序欄位。從欄位篩選器勾選候選值或設定條件。要跨檔追回整張傳票，在文字欄按右鍵選「複製成不重複陣列」，切換資料庫，在目標文字欄選「已複製的陣列」並套用。
3. 在底部選擇數值欄，可核對整個篩選結果的合計、平均、非空筆數。按「欄位」調整要保留的欄，再按「快照」。
4. 在左側「快照」清單中可預覽、改名、複製內容、下載 Parquet，或按「匯出 Excel」另存成 `.xlsx`。快照保留當時的資料與排序，關閉來源後仍可開啟、再次篩選或建立下一份快照。關閉來源只會移除工作區中的登錄，原檔會保留。

Excel 會依快照的欄位及列順序匯出整份資料。每張工作表最多容納 1,048,575 筆資料，超過時自動換頁並重複欄名。一般金額及日期可在 Excel 中運算，超過 15 位精度的數值、帶前導零的文字代碼及時間戳記以文字保留。超過 Excel 欄數或單格文字上限時會顯示錯誤，保留目的地原有檔案。

在左側「筆記本」旁按「新增」可建立 SQL 筆記本。點上方名稱可以改名，名稱旁會顯示自動儲存狀態。「＋ SQL 區塊」可加入更多查詢，點區塊標題可命名，按區塊右上角的 × 可刪除該段查詢。編輯區支援 DuckDB 語法高亮與補全：輸入 `FROM `、`JOIN ` 可選來源或快照，輸入資料表別名加句點可選欄位。Ctrl + Space 可叫出建議，方向鍵選擇，Enter 或 Tab 套用，Esc 關閉。在空白區塊選取「可查詢的資料表」會填入對應的 SELECT。按「執行」或 ⌘/Ctrl + Enter，結果會顯示在該段 SQL 下方，每頁 100 列。「執行並快照」會保留當次查詢的所有列。

上方「匯出」會將名稱與各段 SQL 存成 `.lvnb.json`。左側「筆記本 → 開啟」可將檔案加入工作區，同名筆記本會加上序號。重新開啟工作區後可再執行查詢，或從「快照」檢視之前留存的結果。

預設將來源清單、快照與筆記本保存在應用程式資料目錄的 `ledger.duckdb`。原始 Parquet 從選定位置就地查詢，移動來源後需重新選檔。介面支援繁體中文與英文，可在左下角齒輪的「設定」調整語言和表格行距。

## 🛠️ 開發與建置

安裝 Node.js、Rust 及目標平台的 Tauri 原生建置工具。macOS 需有 Xcode Command Line Tools。首次編譯會從 C++ 原始碼建置 DuckDB。[Tauri 建置環境](https://v2.tauri.app/start/prerequisites/)

```sh
npm ci
npm run tauri -- dev
```

`npm run build` 檢查 TypeScript 並產生前端資產。`npm run tauri -- build` 建置桌面應用程式與該平台的安裝產物。在 macOS 可用 `npm run tauri -- build --bundles app` 產生 `.app`。

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

原生整合測試會建立真實 Parquet，驗證篩選語意、精度、跨檔清單、大檔分頁、快照重開與匯出。開發時可在 WebView console 呼叫 `sqlLog()` 查看原生引擎的 SQL 與操作耗時，`sqlLog(false)` 關閉。

## 🔧 運作方式

| 層級 | 選型 |
| --- | --- |
| 桌面 | Tauri 2，透過 `invoke` 呼叫 Rust |
| 前端 | React、TypeScript、Vite、AG Grid Community，沿用 LedgerView 的表格互動與篩選模型 |
| 查詢 | Rust + `duckdb` crate，內建 DuckDB 2.0.0，直接讀取 Parquet |
| 本機 MCP | Rust 官方 SDK `rmcp` + Axum，支援 Streamable HTTP 與 Claude Desktop 使用的 stdio |

桌面程式直接嵌入 DuckDB，發佈時只需處理桌面程式與原生函式庫的建置和簽章。前端沿用既有 TypeScript 堆疊，查詢由 Rust 提供。Cargo 固定使用 crates.io 的 `duckdb 1.20000.2`，透過 `bundled`、`parquet` 和 `json` features 將 DuckDB 2.0.0 與擴充編入程式。建置環境需能編譯 DuckDB 的 C++ 原始碼。[Tauri commands](https://v2.tauri.app/develop/calling-rust/) · [duckdb 1.20000.2](https://crates.io/crates/duckdb/1.20000.2) · [Cargo features](https://docs.rs/crate/duckdb/1.20000.2/features) · [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)

## 大型 Parquet 與畫面篩選

- 第一版支援本機 Parquet。使用者選檔後，以 `read_parquet` 在原路徑查詢，先讀欄位資訊和首批資料。DuckDB 依查詢選取欄位，並在 Parquet 統計資訊允許時跳過不符合條件的 row group。[DuckDB Parquet](https://duckdb.org/docs/current/data/parquet/overview)
- AG Grid 按需向後端取資料。畫面把欄位、篩選條件和排序傳給 Rust，由 Rust 產生 SQL 並綁定篩選值。跨到 JavaScript 的 `DECIMAL` 和大整數用字串傳輸，以保留精度。
- 同步 DuckDB 查詢由背景 worker 執行。GUI 顯示執行時間並可取消查詢。查詢設定 4 個執行緒、2 GB 引擎記憶體預算與 8 GB 暫存磁碟上限。[DuckDB Connection API](https://docs.rs/duckdb/latest/duckdb/struct.Connection.html) · [DuckDB 效能調校](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)

## 🤖 從 AI 操作 LedgerView

在左下角的 **設定 → MCP** 開啟服務，按 **複製 HTTP 設定** 即可取得用戶端需要的 URL 和 Bearer 授權標頭。預設連線網址為 `http://127.0.0.1:18476/mcp`。關閉 MCP 時可修改連接埠並按「儲存」，留白可恢復預設值。

### Claude Desktop 的本機 stdio

1. 將 LedgerView 放在固定的安裝位置，開啟工作區並啟用 MCP。
2. 按「複製 Claude Desktop 設定（stdio）」。在 Claude Desktop 的 **Settings → Developer → Edit Config** 中，將複製的 `LedgerView` 項目合併到 `mcpServers`。第一次建立設定檔時可貼上整份 JSON。
3. 完全退出並重新開啟 Claude Desktop。保持 LedgerView 開啟，請 Claude 列出工作區的資料表即可驗證連線。

Claude 會以 `--mcp-stdio` 啟動同一個 LedgerView 執行檔，透過 macOS 的 Unix socket 或 Windows 的本機 named pipe 連回桌面工作區。啟用 MCP 期間，同一個作業系統帳號執行的程序可以連線。Claude 設定只需執行檔路徑和參數。從舊版升級時，請重新複製設定以移除原有權杖；若移動執行檔也需要更新路徑並重啟 Claude Desktop。[MCP 本機連線指南](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

### 工作區權限與工具

磁碟工作區會將連接埠及權杖存入 `ledger.duckdb`。首次成功啟用時會顯示完整權杖，關閉設定後即隱藏。重開 LedgerView 後，啟用 MCP 即可沿用原設定。按「重新產生」會顯示新權杖並立即撤銷舊權杖。記憶體模式使用預設連接埠，權杖僅保留至程式退出。[MCP 傳輸規格](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

啟用期間，連線的 AI 可查詢整個工作區的來源和快照、讀取及編輯所有筆記本。在設定中打開診斷日誌，可看到標示為 MCP 的 SQL、耗時及錯誤。

| 工具 | 行為 |
| --- | --- |
| `list_sources` | 列出資料表別名、欄位名稱及型別。 |
| `query` | 執行一段唯讀 DuckDB SQL。預設將第一頁回傳給 AI。設 `preview: true` 會開啟全螢幕「預覽」，AI 收到結果 ID 和列數。使用者可在左下角按「快照」保存完整結果，之後 AI 可用 `save_snapshot` 的 `replaceId` 覆寫同一份快照。 |
| `result_page` | 使用前一頁的 `next` 取得後續資料。每頁最多 100 列，資料列內容最多 512 KiB。 |
| `save_snapshot` | 使用結果 ID 保存完整結果。傳 `focus: true` 可切換到該快照。之後指定同一個 `replaceId`，可整份更新 AI 建立的快照。 |
| `export_excel` | 將整份快照或查詢結果匯出成 Excel。指定 `snapshotId` 或 `resultId`，可附上 `fileName`（例如 `摘要.xlsx`）。檔案只會存到設定中「開啟工作目錄」的資料夾，同名檔案會保留。 |
| `list_notebooks` | 讀取筆記本、區塊名稱、SQL 與編輯版本。 |
| `edit_notebook` | 建立筆記本，或依 `expectedRevision` 編輯現有筆記本的名稱、區塊與 SQL。既有區塊保留 slot，新區塊省略 slot。若使用者已修改，工具會回報衝突。 |

MCP 查詢使用獨立的 DuckDB 實例，直接讀取已開啟的原始 Parquet。工作區快照以本次連線的暫存 Parquet 提供給查詢。SQL 執行上限 60 秒，最近八份成功結果可供翻頁、預覽與建立快照。關閉 MCP 或退出 LedgerView 時會清除 MCP 專用快取目錄裡的查詢結果及快照副本。若程式意外中斷，下次啟動會清除上次遺留的快取。已存快照及筆記本依工作區模式保存。在設定中按「開啟工作目錄」可前往保存 `ledger.duckdb` 的資料夾。

## 📊 測試與效能

測試使用合成資料驗證 Excel 匯出的欄位型別、文字精度、列序及覆寫失敗時的檔案保護。CI 也會透過打包後執行檔的 stdin/stdout 列出 MCP 工具，並查詢測試工作區。

在 Apple Silicon macOS 的原生 WebView 測試中，拖入 75,000,000 列、7 欄、10.53 GB 的合成 Parquet，在作業系統已有檔案快取的單次測量中，從拖入到顯示首列約 0.54 秒。另驗證了全檔篩選、排序、取消執行中的排序及取消後繼續查詢。

## 後續效能與 MCP 驗證

用目標平台的安裝產物開啟代表性大檔，量測首屏時間、常用篩選與全檔排序的延遲、尖峰記憶體和暫存磁碟用量。用實際 MCP client 查同一份資料，驗證 agent 彙總時仍可操作畫面，以及取消請求能中止 DuckDB 查詢。可用 LedgerView 現有的約 30 GB 合成 Parquet 產生器做壓力測試。[LedgerView 大檔測試資料](https://github.com/tommy87166/LedgerView/blob/main/scripts/generate-fixtures.mjs#L116)
