# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-04 收工
- 機器：桌機
- 版本：**main = v03.00（已上線）**。schema 仍為 2、向下相容，未觸發改版重置。
- 狀態：本次變更皆已 push main、GH Pages 生效。無待接續工作。

## 本次 session 做了什麼（v02.02 → v03.00）
### 1) App 新功能 v03.00：一鍵輸出 .docx 課表
- 課表輸出頁新增「📄 所有班級課表(.docx)」「📄 所有教師課表(.docx)」，每班/每師一頁，版面比照三民國小範本（整潔活動/導師時間/升旗/午餐/午休/第八節固定列＋分鐘/時間欄、**週三下午教學研究(合併)**、班級表右側「科目節數＋任課老師」清單＋學生人數欄留空/級任導師）。
- 純前端自寫 OOXML＋ZIP 產生器 **`docx_gen.js`**（無依賴；獨立 `<script>` 掛 index.html＋sw ASSETS）。設定頁新增「課表輸出格式」：校名/學年度/科目顯示名稱對照（`settings.reportSchool`/`reportYear`/`subjectMap`）。
- 已用 Node＋python-docx 驗證結構、瀏覽器內實測產出有效 .docx、UI 端到端過。sw CACHE_NAME→v03.00。
- **踩雷**：zip local file header 必須 30 bytes（曾少一個 2-byte 欄→Word BadZipFile）。

### 2) 外部 CP-SAT 自動填課流程（新增，非 App 內功能）
- 使用者上傳課務編排匯出 JSON＋指定規則 → 我用 OR-Tools CP-SAT 自動填課 → 產可匯入 JSON（只改 slots/slotTeachers）。
- repo 內：`tools/auto_schedule.py`＋`tools/verify_schedule.py`（獨立驗證）＋`tools/render_timetable.py`；根目錄 **`排課規則.md`** 為完整規則書。`tools/state*.json`、`timetable.html` 已 gitignore（真實學校資料不入 repo）。
- 規則：硬性 R1–R12＋偏好 P1–P5。詳見 `排課規則.md`。
- **★ 母語為結構性例外**（R10/R1/P4 皆豁免母語）；**週三半天(教研)**：級任平衡納入週三、科任除外。
- 環境：本機 `python`(Inkscape)無 ortools，要用 `C:\Users\TTCT\AppData\Local\Programs\Python\Python312\python.exe`＋`PYTHONUTF8=1`。

## 下一步
- （無待接續工作。）App 與自動填課流程都可續用/增修。

## 待決 / 卡住的問題
- （無）docx 版面已用 python-docx 驗證結構，但**未實際在 Word 開啟確認排版微調**（欄寬/字級）——已把範例 docx 交使用者確認，如需微調再處理。
- docx 班級表右側 legend 目前**逐科各列一行**，未做範本的「領域合併」（如健康+體育→健體）；使用者若要領域合併再加。

## 注意事項（給另一台的 Claude）
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
- 版本 vNN.MM：APP_VERSION(app.js)＋sw CACHE_NAME 必須同步。小改直接 bump minor、大改先確認。現 **v03.00**。
- 自動填課要跑 CP-SAT：`python tools/auto_schedule.py <秒>` → `python tools/verify_schedule.py state_filled.json`（須 0 錯誤）；改規則時求解器＋驗證器兩邊都要同步改。
