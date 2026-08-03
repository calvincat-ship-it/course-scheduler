# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-03
- 機器：桌機
- 版本：v01.04（連堂實作：自動成對＋未相鄰警示）

## v01.04 變更
- **連堂功能化**（原本只是標籤）。`assignment.consecutive` 現在真的生效：
  - **自動成對放課**：放一筆需連堂的課，自動把相鄰一節一起排入（優先 next、否則 prev）。`placeAssignment()` 統一「放格＋協同同步」，連堂再呼叫一次放相鄰節；受 `placedCount<periods` 上限保護、`periods>=2` 才作用。
  - **相鄰定義** `adjacentLessonPeriod(pid,day,dir)`：只看陣列上緊鄰的節，且該節該日有課（periodHasDay）；午休/下課(days=[])或本日未上課→不相鄰（不跨午休）。
  - **未相鄰警示**：衝堂引擎新增「連堂未相鄰」（consecutive 且 periods>=2、同日相鄰節沒有同一門課接續）。
  - **設定開關** `settings.autoPairConsecutive`（預設 true，migrate 補）；設定頁「排課選項」可取消勾選「需連堂排課時，自動成對放課」。關閉只停自動放，警示照舊。
  - 盤面徽章依原因顯示「衝堂／協同未同步／連堂未相鄰」；橫幅改「需注意的格子」。
- 版本 v01.04（APP_VERSION、sw 同步）。

## v01.03 變更
- **協同教學**：`assignment.coteach`（群組 id）；同組配課須排同一時段。
  - 配課 modal 加「🔗 協同教學」勾選區（列同科目其他班；隨科目下拉刷新 `coteachPickerHTML`）；`applyCoteach(meId, memberIds)` 統一群組、`cleanupCoteachSingletons()` 清落單；刪配課後也清。migrate 補 `coteach:''`。
  - 排課：放課時同組其他班自動排入同一格（僅填空格）、移除時一併移除（cell-click handler）。
  - 衝堂引擎：同組彼此**跳過**教師/教室衝堂；新增「**協同未同步**」檢查（同組沒排同格）。群組外仍正常判衝堂。
  - 視覺：協同格顯示 🔗、調色盤/配課清單標「🔗協同」、conf-mark 依原因顯示「協同未同步」或「衝堂」。
- 版本三處同步 v01.03（APP_VERSION、sw、index versionTag 由 JS 覆寫）。

## v01.02 變更
- **節次表由整週 `lesson` 布林 → 每節每日 `days:[dayNums]` 陣列**。設定頁每節顯示「週一～週五」勾選格（欄位依上課日）；未勾的格子在排課盤面/教師課表顯示灰色斜紋 `.cell.blocked` 不可放；整節無任何上課日＝分隔列（isLessonPeriod 判定）。
- helpers：`periodHasDay(p,d)`、`isLessonPeriod(p)`；`lessonPeriods()` 改用 isLessonPeriod。
- migrate 自動轉換舊資料（`lesson:false→days:[]`、其餘→當時 settings.days）。教師不排課格只在該節該日有課時可點（否則 `.slot.na`）。
- 版本三處同步：APP_VERSION、sw CACHE_NAME、index versionTag(JS 覆寫)。

## v01.01 變更
- 新增 App 內「❓ 使用說明」按鈕（頂列，openModal wide 可捲動）＋首次開啟自動彈出一次（`state.helpSeen` 旗標，migrate 補預設）。內容＝repo 內「使用說明.md」的精簡版（helpContent()）。
- 另有完整 `使用說明.md`（GitHub 可讀）。

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
