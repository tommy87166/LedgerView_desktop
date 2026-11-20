# LedgerView Desktop

LedgerView 的桌面版。使用者可在本機開啟大型 Parquet 檔、瀏覽資料並依欄位篩選。支援 Streamable HTTP 的本機 MCP client 也可對使用者授權的資料集執行 SQL。[LedgerView Web 版](https://github.com/tommy87166/LedgerView)

[LedgerView Web 版功能盤點](docs/ledgerview-web-features.md) 記錄既有的跨檔查帳、快照與底稿輸出流程，供桌面版功能討論時對照。

## 技術選型

| 層級 | 選型 |
| --- | --- |
| 桌面 | Tauri 2，透過 `invoke` 呼叫 Rust |
| 前端 | React、TypeScript、Vite、AG Grid Community，沿用 LedgerView 的表格互動與篩選模型 |
| 查詢 | Rust + `duckdb` crate，原生 DuckDB 直接讀取 Parquet |
| MCP | Rust 官方 SDK `rmcp` + Axum，使用 Streamable HTTP |

桌面程式直接嵌入 DuckDB，發佈時只需處理桌面程式與原生函式庫的建置和簽章。前端沿用既有 TypeScript 堆疊，查詢與 MCP 由 Rust 提供。第一版用 `duckdb` 的 `bundled` 和 `parquet` features 隨程式編入引擎，建置環境需能編譯 DuckDB 的 C++ 原始碼。[Tauri commands](https://v2.tauri.app/develop/calling-rust/) · [DuckDB Rust](https://github.com/duckdb/duckdb-rs) · [Cargo features](https://docs.rs/crate/duckdb/latest/features) · [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)

## 大型 Parquet 與畫面篩選

- 第一版支援本機 Parquet。使用者選檔後，以 `read_parquet` 在原路徑查詢，先讀欄位資訊和首批資料。DuckDB 依查詢選取欄位，並在 Parquet 統計資訊允許時跳過不符合條件的 row group。[DuckDB Parquet](https://duckdb.org/docs/current/data/parquet/overview)
- AG Grid 按需向後端取資料。畫面把欄位、篩選條件和排序傳給 Rust，由 Rust 產生 SQL 並綁定篩選值。跨到 JavaScript 的 `DECIMAL` 和大整數用字串傳輸，以保留精度。
- 同步 DuckDB 查詢由背景 worker 執行。GUI 和 MCP 使用各自的連線，共用同一工作階段的資料集，並可獨立取消查詢。大型排序與彙總需設定資源預算，並量測暫存磁碟用量。[DuckDB Connection API](https://docs.rs/duckdb/latest/duckdb/struct.Connection.html) · [DuckDB 效能調校](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)

## 本機 MCP

- 由使用者啟用後，才在 `http://127.0.0.1:<port>/mcp` 提供 Streamable HTTP。端點需要授權憑證，驗證 `Host` 與請求所帶的 `Origin`。GUI 透過 Tauri IPC 使用查詢服務，MCP 可獨立開關。[MCP 傳輸規格](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- 首版提供資料集清單、欄位資訊與唯讀 SQL。使用者逐個資料集授權，SQL 執行環境限制外部檔案與網路存取、擴充套件載入、查詢時間及回傳大小。[DuckDB 安全設定](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)

## 原型驗證

用目標平台的安裝產物開啟代表性大檔，量測首屏時間、常用篩選與全檔排序的延遲、尖峰記憶體和暫存磁碟用量。用實際 MCP client 查同一份資料，驗證 agent 彙總時仍可操作畫面，以及取消請求能中止 DuckDB 查詢。可用 LedgerView 現有的約 30 GB 合成 Parquet 產生器做壓力測試。[LedgerView 大檔測試資料](https://github.com/tommy87166/LedgerView/blob/main/scripts/generate-fixtures.mjs#L116)
