# LedgerView Web 版功能盤點

本文件記錄 LedgerView Web 版 0.8.0 的操作行為，供桌面版討論功能範圍時對照。盤點基準為 `main` 的 `68ddf1d`。在此版本執行 `npm test`，11 個測試檔、115 個案例全部通過，涵蓋篩選、DuckDB 查詢、Parquet 分頁、快照及 Excel 日期轉換。[來源版本](https://github.com/tommy87166/LedgerView/tree/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b) · [DuckDB 整合測試](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/sql/builder.integration.test.ts)

## 查帳範例：從單一科目追回整張傳票

1. 在科目明細分頁篩出要查的科目與日期，對文字型的「傳票號」按右鍵，選「複製成不重複陣列」。系統會從所有命中列取出相異傳票號。
2. 到完整分錄的分頁，打開「傳票號」欄篩選器，選「已複製的陣列」並套用。每個傳票號都能命中多筆分錄，因此同張傳票的其他科目也會出現。[右鍵操作](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/LedgerGrid.tsx) · [套用陣列](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/filters/TextColumnFilter.tsx)
3. 選定金額欄，核對命中列數、金額合計與有值筆數。隱藏交付時不需要的欄位，按「快照」，即可從面板複製到 Excel 或下載底稿。[彙總及快照操作](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/layout/AppShell.tsx) · [快照面板](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/snapshots/SnapshotPanel.tsx)

## 開檔、分頁與保存

| 輸入 | 操作與資料保存方式 |
| --- | --- |
| UTF-8 CSV、TSV、TXT | 選檔或拖入，多檔排隊處理。DuckDB 自動辨識標題、分隔符並推斷型別，將明細存為資料表。偵測到其他編碼時會提示另存為 UTF-8。 |
| Excel（XLSX、XLS） | 精靈可一次勾選多張工作表，每張各開一個分頁。預覽最多 30 列，可點選標題列，覆寫自動推斷的文字、數字、日期、日期時間或布林型別。空欄名會補名，重複欄名會加後綴。 |
| Parquet | 建立 DuckDB view。磁碟模式會先檢查空間，把原檔串流複製到瀏覽器私有檔案系統（OPFS），重開時重新註冊檔案。記憶體模式直接讀取使用者選的檔案，本次工作階段有效。 |

CSV 1 GB、Excel 100 MB、Parquet 10 GB 是可選擇繼續的大小警告。OPFS 可用空間不足以容納 Parquet 副本時會停止該次匯入。原專案記錄了磁碟模式下捲動與篩選 9 GB、8 億列、8 欄 Parquet 的實測。[匯入佇列與格式](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/hooks/useImportManager.ts) · [Excel 精靈](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/import/XlsxWizard.tsx) · [Parquet 開檔流程](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/importers/parquet.ts) · [原專案實測](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/README.zh-TW.md#L128)

切換資料集會重建表格並重設篩選、排序與選定的彙總欄。各分頁的隱藏欄位會保留到這次工作階段結束。行距有緊湊、標準、寬鬆、特寬四檔，行距和繁中／英文介面偏好都能在重開後還原。關閉一般資料集會要求確認，再移除程式管理的資料表或 Parquet 副本。關閉快照預覽只收起該分頁。[主畫面](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/layout/AppShell.tsx) · [分頁狀態](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/store/datasets.ts) · [顯示偏好](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/prefs.ts)

## 表格、篩選與金額核對

表格按需每批讀取 200 列。固定在左側的列號從 1 開始，排序或篩選後仍顯示該列在來源資料集中的序號。欄寬可調，可逐欄顯示或隱藏，欄名提示會列出 DuckDB 型別。狀態列提供一鍵清除所有篩選及排序。[表格](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/LedgerGrid.tsx) · [欄位與列號](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/columnDefs.ts)

| 操作 | 行為 |
| --- | --- |
| 勾選清單 | 候選值受其他欄條件連動，最多載入 1,000 個相異值。搜尋範圍是已載入的清單，全選／取消作用於搜尋後可見的項目。完全不勾再套用會得到零列，按「清除」則解除整欄限制。 |
| 文字條件 | 可選等於、不等於、包含、不包含、開頭、結尾、空白、非空白，也可用「且／或」串接兩個條件。按「套用」後生效。 |
| 數字、日期、布林 | 數字支援比較與含端點的區間。日期時間可顯示到秒，日期篩選以日為單位。布林欄採清單勾選，可含空白。 |
| 儲存格右鍵 | 可複製單一值，或保留其他欄條件、用此值篩選當前欄。文字欄另可複製去重陣列。 |
| 跨欄、跨檔帶值 | 陣列收錄整個目前篩選結果的相異值，略過 SQL `NULL`，取值時沒有勾選清單的 1,000 值上限。剪貼簿格式為 `{"selected":[...]}`。在另一個文字欄套用後，任一清單值相符即命中。 |

[勾選清單](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/filters/DistinctListPanel.tsx) · [篩選模型](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/filters/textFilterModel.ts) · [各型別的 SQL 語意](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/sql/filter-model.ts) · [複製去重值](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/grid/LedgerGrid.tsx#L104)

畫面顯示來源列數，命中列數不同時另列篩選後筆數。選擇數值欄後，DuckDB 對完整篩選結果計算合計、平均與該欄非空筆數。例如篩出 100 列，其中 3 列金額為空，金額欄的計數是 97。Web 版把合計與平均轉為 `DOUBLE`，狀態列最多顯示兩位小數。[彙總查詢](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/sql/builder.ts) · [狀態列](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/layout/AppShell.tsx#L105)

## 快照與工作底稿

建立快照時，DuckDB 把符合條件的列依指定排序寫進獨立資料表，只納入當時可見的資料欄。隱藏欄位上的篩選和排序仍參與查詢。快照記錄來源名稱、篩選、排序、列數、欄數及建立時間，因此來源分頁關閉後仍能個別管理。在磁碟模式下，重開程式可還原已保存的快照。[快照服務](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/snapshots/service.ts) · [快照查詢](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/sql/builder.ts)

快照會自動命名，面板可改名、預覽或刪除。點開同一份快照會回到它的預覽分頁，預覽中可以繼續篩選並建立下一份快照。面板提供以下逐份輸出操作。[快照面板](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/snapshots/SnapshotPanel.tsx) · [預覽與分頁](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/components/layout/AppShell.tsx)

| 輸出 | 使用者會看到的結果 |
| --- | --- |
| 複製到 Excel | 複製含欄名的 TSV。資料列數乘欄數超過 20 萬格時詢問是否繼續，超過 200 萬格時引導改用下載。 |
| CSV、Parquet | 由 DuckDB 寫出快照內容。CSV 帶 UTF-8 BOM，方便用 Excel 開啟中文。 |
| XLSX | 每份快照寫入一張工作表，含標題列的上限為 1,048,576 列。日期及日期時間輸出為可讀文字，超出 JavaScript 安全整數範圍的大整數以字串保留。 |

批次 ZIP 出現在早期更新紀錄，匯出模組也保有打包函式。此版本快照面板提供的下載入口為單份 XLSX、CSV 和 Parquet。[剪貼簿門檻](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/exporters/clipboard.ts) · [CSV、TSV 與 Parquet](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/exporters/duckdb-copy.ts) · [Excel 匯出](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/exporters/xlsx-export.ts) · [ZIP 函式](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/lib/exporters/snapshot-export.ts) · [更新紀錄](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/src/changelog.ts)

## 大檔輔助工具

repo 另附兩支命令列工具。`to-parquet` 可將 SQLite 或大型 Excel 轉成 Parquet，`repartition` 可把既有 Parquet 改寫成較小的 row group 或分割成多檔，供瀏覽器處理。[資料轉檔](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/scripts/to-parquet.mjs) · [Parquet 分割](https://github.com/tommy87166/LedgerView/blob/68ddf1d9f0e0fe3779278ca5a3147d00df8c661b/scripts/repartition-parquet.mjs)
