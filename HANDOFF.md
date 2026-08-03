# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-03
- 機器：桌機
- 版本：v01.00（MVP 骨架）

## 線上位置
- Repo：https://github.com/calvincat-ship-it/course-scheduler
- Live（GH Pages）：https://calvincat-ship-it.github.io/course-scheduler/
- 已開 Issues，供同仁回報問題／建議。

## 做到哪
- 建立專案骨架：serve.js（port 5177）、PWA 四件套（index/style/app/sw/manifest/icon.svg）、CLAUDE.md、本檔。
- 已加入 root `.claude/launch.json` 設定：`course-scheduler`。
- **已上線**：建 GitHub repo（calvincat-ship-it）、push main、開 GH Pages（main / root），線上版實測 200、無 console error。
- **MVP 核心功能（v01.00）**：
  - 資料層：IndexedDB 單一 state 文件（in-memory + 整包持久化），key `state`，DB `course_scheduler`。
  - 設定：節次表（可增刪改、標記上課/下課午休）、上課日切換。
  - 主檔 CRUD：班級（年級）、教師（類別/節數上限/不排課時段格）、科目（是否需專科教室/是否連堂）、專科教室。
  - 配課：班級–科目–教師–每週節數（可指定教室/連堂）。
  - **手動排課盤面**：選班級→週課表格；左側配課調色盤（顯示 已排/應排）；點選配課→點空格放課、點已放格移除；即時三種衝堂（教師/班級/教室）紅框；教師總節數 vs 上限即時檢核。
  - 課表輸出：班級表、教師個人表；列印 / 存 PDF（瀏覽器列印）、CSV 匯出（Excel）。
  - 備份：整包 JSON 匯出 / 匯入。

## 下一步（依當初架構規劃的進階項）
- 各年級「領域節數參考表」與配課時的剩餘節數提示（目前僅到配課層檢核）。
- 半自動建議（某空格可放誰、某老師哪些格可調）＋三角/多角調課建議。
- 一鍵自動排課引擎（CSP 回溯＋MRV＋局部搜尋）—— 檢核器已模組化，可沿用。
- 全校總表輸出、PNG 圖示（目前只有 SVG）。
- （選配）Google Drive 同步—— 資料層已是單一 state 文件，易接。

## 待決 / 卡住的問題
- （無）。已上線收集同仁回饋中。PNG 圖示尚缺（目前只有 SVG，PWA 安裝可用）。

## 注意事項（給另一台的 Claude）
- 版本 vNN.MM：小改直接 bump minor；大改先確認。APP_VERSION（app.js）與 sw.js CACHE_NAME 要同步。
- 資料只存本機 IndexedDB（單一 key `state`）；換機器不會自動帶資料 → 用「匯出 JSON」搬。日後接 Drive 同步再改。
- 排課格子鍵：`${classId}|${day}|${period}`；衝堂檢核靠掃描所有 slots 比對同 day/period 的 teacherId / roomId。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
