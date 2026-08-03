# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-04 收工
- 機器：筆電
- 版本：**main = v02.02（已上線）**。schema 仍為 2、向下相容，未觸發改版重置。
- 狀態：本次兩項變更皆本機實測通過、無 console error、已 push main、GH Pages 生效。無待接續工作。

## 本次 session 做了什麼（v02.00 → v02.02）
### v02.01 — 教師配課下拉修正（bug fix）
- 配課下拉**不再顯示已被其他教師配滿的科目**（非分組）；部分配置顯示「剩N節」；分組顯示「分組·每組N節」。
- 節數輸入 `max`=剩餘、change 時夾回上限並提示；換班/換科自動選第一個可配科目；存檔前防呆超額擋下。
- `remainingForRow()` 剩餘=required−其他教師−本 modal 其他列；**排除正在編輯的教師本人**（editingTeacherId）。

### v02.02 — 新增「分節上課」第三種科目模式（大改，已與使用者確認）
- 需求：一科節數分攤給不同老師、各上不同節（如生活 6 節＝A 上 4＋B 上 2）。
- 科目教學型態改**三選一**：單一教師／👥分組教學（同節平行）／✂️分節上課（不同節、節數分攤）。subjectModal 用 mode select，存成 `allowGrouping`/`splitTeachers` 兩布林。
- **資料模型**：新增 `state.slotTeachers[key]=teacherId`（每格記錄該節由誰上），schema 不變、向下相容；init/匯入補 guard，舊資料自動補 `{}`、舊分節格缺師顯示「（未指定老師）」。
- **核心 helper `slotAssignments(key)`**：回傳該格 [{teacherId,roomId}]——分節→只該格記錄的單一師；分組/單一→全部配課師。衝堂/不排課/教師課表/CSV/teacherScheduled 全改用它。
- checkStaffing 分節分支：Σ==required 即合格、允許多師。
- 調色盤：分節科目**每位配課師各一色塊**（各自 placed/該師 hours），先選老師（selectedTeacherId）再放課；placeSubject 帶 teacherId、分節跳過協同同步、連堂沿用同師；刪教師連帶清其分節格。
- 使用說明（App 內 helpContent + 使用說明.md）已補分節上課說明。

## 環境（筆電本次新增）
- course-scheduler 原本筆電沒有→已 clone；補進 root `.claude/launch.json`（name `course-scheduler`、port 5177）。
- 設 **global** git 身分（calvincat / calvincat@ttct.edu.tw），未來新 clone 免再設。
- sync-start 自動掃 `.git` 資料夾，clone 後開工會自動一起 pull。

## 下一步
- （無待接續工作。）roadmap 進階項仍在：一鍵自動排課引擎、半自動調課建議、領域節數參考表、Google Drive 同步、PNG 圖示。

## 待決 / 卡住的問題
- （無）。分節上課已完整實測（閘門/色塊計數/放課記錄師/班級+教師課表分流/不排課衝堂歸屬/migration guard）。

## 注意事項（給另一台的 Claude）
- 版本 vNN.MM：APP_VERSION（app.js）與 sw CACHE_NAME 必須同步。小改 bump minor、大改先確認。
- **分節上課關鍵欄位** `state.slotTeachers`（勿刪）；讀取一格實際上課師一律走 `slotAssignments(key)`，別直接 `loadsForClassSubject`（那會回傳全部配課師、分節會算錯）。
- 測試存取：裸名 `state` 讀得到、`window.state` 讀不到（script-scope let）；in-app Browser preview 重啟會清 IndexedDB，seed 前先重啟後再寫。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
