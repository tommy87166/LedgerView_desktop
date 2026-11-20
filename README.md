# LedgerView

LedgerView 在本機開啟 Parquet 明細帳，沿用 LedgerView Web 0.8.0 的表格操作。可以從科目明細複製傳票號清單，切到完整分錄查出對應項目，核對金額，再留存工作底稿。[線上版](https://ledgerview.pages.dev/) · [Web 版功能盤點](docs/ledgerview-web-features.md)

## 開始使用

1. 在左側「資料庫」旁按「開啟」選取一或多個 `.parquet`，也可以直接拖入視窗。點選側欄中的檔名即可切換右側表格。程式記住原始路徑，重開時會再次讀取該檔案。
2. 點欄名排序，按住 Shift 可加入第二個排序欄位。從欄位篩選器勾選候選值或設定條件。要跨檔追回整張傳票，在文字欄按右鍵選「複製成不重複陣列」，切換資料庫，在目標文字欄選「已複製的陣列」並套用。
3. 在底部選擇數值欄，可核對整個篩選結果的合計、平均、非空筆數。按「欄位」調整要保留的欄，再按「快照」。
4. 在左側「快照」清單中可預覽、改名、複製內容或另存 Parquet。快照保留當時的資料與排序，關閉來源後仍可開啟、再次篩選或建立下一份快照。關閉來源只會移除工作區中的登錄，原檔會保留。

在左側「筆記本」旁按「新增」可建立 SQL 筆記本。點上方名稱可以改名，名稱旁會顯示自動儲存狀態。「＋ SQL 區塊」可加入更多查詢，點區塊標題可命名，按區塊右上角的 × 可刪除該段查詢。編輯區支援 DuckDB 語法高亮與補全：輸入 `FROM `、`JOIN ` 可選來源或快照，輸入資料表別名加句點可選欄位。Ctrl + Space 可叫出建議，方向鍵選擇，Enter 或 Tab 套用，Esc 關閉。在空白區塊選取「可查詢的資料表」會填入對應的 SELECT。按「執行」或 ⌘/Ctrl + Enter，結果會顯示在該段 SQL 下方，每頁 100 列。「執行並快照」會保留當次查詢的所有列。

上方「匯出」會將名稱與各段 SQL 存成 `.lvnb.json`。左側「筆記本 → 開啟」可將檔案加入工作區，同名筆記本會加上序號。重新開啟工作區後可再執行查詢，或從「快照」檢視之前留存的結果。

預設將來源清單、快照與筆記本保存在應用程式資料目錄的 `ledger.duckdb`。原始 Parquet 從選定位置就地查詢，移動來源後需重新選檔。介面支援繁體中文與英文，可在左下角齒輪的「設定」調整語言和表格行距。

## 開發與建置

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

### 從 GitHub 下載桌面版

推送到 `main`、向 `main` 提出 pull request，或手動執行工作流程時，GitHub Actions 會在 Windows 和 macOS 各自建置桌面版並執行前端與 Rust 測試。開啟成功的執行紀錄，在 **Artifacts** 下載對應平台的檔案。[桌面版 CI](https://github.com/tommy87166/LedgerView_desktop/actions/workflows/desktop.yml)

| 平台 | 下載檔 | 使用方式 |
| --- | --- | --- |
| Windows x64 | `LedgerView.exe` | 直接執行。DuckDB 已編入執行檔，介面使用系統的 Microsoft Edge WebView2 Runtime。 |
| macOS Apple Silicon | `LedgerView-macOS-arm64.app.zip` | 解壓縮後開啟 `LedgerView.app`。此版本使用 ad hoc 簽章，尚未通過 Apple 公證。 |

## 技術選型

| 層級 | 選型 |
| --- | --- |
| 桌面 | Tauri 2，透過 `invoke` 呼叫 Rust |
| 前端 | React、TypeScript、Vite、AG Grid Community，沿用 LedgerView 的表格互動與篩選模型 |
| 查詢 | Rust + `duckdb` crate，內建 DuckDB 2.0.0，直接讀取 Parquet |
| 本機 MCP | Rust 官方 SDK `rmcp` + Axum，使用 Streamable HTTP |

桌面程式直接嵌入 DuckDB，發佈時只需處理桌面程式與原生函式庫的建置和簽章。前端沿用既有 TypeScript 堆疊，查詢由 Rust 提供。Cargo 固定使用 crates.io 的 `duckdb 1.20000.2`，透過 `bundled`、`parquet` 和 `json` features 將 DuckDB 2.0.0 與擴充編入程式。建置環境需能編譯 DuckDB 的 C++ 原始碼。[Tauri commands](https://v2.tauri.app/develop/calling-rust/) · [duckdb 1.20000.2](https://crates.io/crates/duckdb/1.20000.2) · [Cargo features](https://docs.rs/crate/duckdb/1.20000.2/features) · [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)

## 大型 Parquet 與畫面篩選

- 第一版支援本機 Parquet。使用者選檔後，以 `read_parquet` 在原路徑查詢，先讀欄位資訊和首批資料。DuckDB 依查詢選取欄位，並在 Parquet 統計資訊允許時跳過不符合條件的 row group。[DuckDB Parquet](https://duckdb.org/docs/current/data/parquet/overview)
- AG Grid 按需向後端取資料。畫面把欄位、篩選條件和排序傳給 Rust，由 Rust 產生 SQL 並綁定篩選值。跨到 JavaScript 的 `DECIMAL` 和大整數用字串傳輸，以保留精度。
- 同步 DuckDB 查詢由背景 worker 執行。GUI 顯示執行時間並可取消查詢。查詢設定 4 個執行緒、2 GB 引擎記憶體預算與 8 GB 暫存磁碟上限。[DuckDB Connection API](https://docs.rs/duckdb/latest/duckdb/struct.Connection.html) · [DuckDB 效能調校](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)

## 從 AI 操作 LedgerView

開啟 LedgerView，在左下角 **設定 → 啟用本機 MCP** 勾選後，按 **複製連線設定**。把 URL 和授權標頭填入支援 Streamable HTTP 的 MCP 用戶端。服務位於 `http://127.0.0.1:18476/mcp`，每次重新啟用都會產生新的權杖。關閉服務或退出程式即中止連線。[MCP 傳輸規格](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

啟用期間，連線的 AI 可查詢整個工作區的來源和快照、讀取及編輯所有筆記本。在設定中打開診斷日誌，可看到標示為 MCP 的 SQL、耗時及錯誤。

| 工具 | 行為 |
| --- | --- |
| `list_sources` | 列出資料表別名、欄位名稱及型別。 |
| `query` | 執行一段唯讀 DuckDB SQL。預設將第一頁回傳給 AI；設 `preview: true` 會在桌面開啟預覽，AI 收到結果 ID 和列數。 |
| `result_page` | 使用前一頁的 `next` 取得後續資料。每頁最多 100 列，資料列內容最多 512 KiB。 |
| `save_snapshot` | 使用結果 ID 保存完整結果。傳 `focus: true` 可切換到該快照。之後指定同一個 `replaceId`，可整份更新 AI 建立的快照。 |
| `list_notebooks` | 讀取筆記本、區塊名稱、SQL 與編輯版本。 |
| `edit_notebook` | 建立筆記本，或依 `expectedRevision` 編輯現有筆記本的名稱、區塊與 SQL。既有區塊保留 slot，新區塊省略 slot。若使用者已修改，工具會回報衝突。 |

MCP 查詢使用獨立的 DuckDB 實例，直接讀取已開啟的原始 Parquet。工作區快照以本次連線的暫存 Parquet 提供給查詢。SQL 執行上限 60 秒，最近八份成功結果可供翻頁、預覽與建立快照。關閉 MCP 後清除暫存結果；已存快照及筆記本依工作區模式保存。

## 大檔驗證

在 Apple Silicon macOS 的原生 WebView 測試中，拖入 75,000,000 列、7 欄、10.53 GB 的合成 Parquet，在作業系統已有檔案快取的單次測量中，從拖入到顯示首列約 0.54 秒。另驗證了全檔篩選、排序、取消執行中的排序及取消後繼續查詢。

## 後續效能與 MCP 驗證

用目標平台的安裝產物開啟代表性大檔，量測首屏時間、常用篩選與全檔排序的延遲、尖峰記憶體和暫存磁碟用量。用實際 MCP client 查同一份資料，驗證 agent 彙總時仍可操作畫面，以及取消請求能中止 DuckDB 查詢。可用 LedgerView 現有的約 30 GB 合成 Parquet 產生器做壓力測試。[LedgerView 大檔測試資料](https://github.com/tommy87166/LedgerView/blob/main/scripts/generate-fixtures.mjs#L116)
