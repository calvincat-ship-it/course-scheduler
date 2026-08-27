# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-27 收工
- 機器：（本次 session 的機器；Desktop\claude code）
- 版本：**main = v10.00（已 push；GH Pages 部署中/待確認）**。schema 仍為 2、向下相容。
- 狀態：全部本機（預覽 + DOM 量測）實測通過、無 console error、已 push main。

## 本次區間做了什麼（v09.37 → v10.00）＝②版面調整 + 雲端修復 + 診斷 + 教室引導 + **代課新功能**
- **v09.37–41 ②年級與班級「科目節數」改版**：(37) 修 `.grade-cols` 第二張卡被 `.card+.card` margin 下移 14px→上緣對齊；(38) 已勾科目改**卡片化**多欄 `.subjh-cards`（每卡：科目 pill+節數 input+右上✕移除，`grade-subj-off` action），未勾科目收進「＋加開科目」`.offsubj-fold` 摺疊；(39–40) 卡片**下挖凹槽**視覺（inset 陰影漸深至 .34/9px/16px、白底輸入浮起對比）；(41) **卡片底色改用各科目色**（`--sc` 變數 + `color-mix` 混白淡色調漸層）。
- **v09.42 雲端同步「🔍 診斷」只讀檢查**：列授權帳號 vs 本機記錄帳號、App 資料夾全部檔案(名/時間/大小)、原始 HTTP 錯誤、判讀。放在設定→雲端卡片。（`cloudDiagnose`）
- **v09.43 雲端還原/備份修復（重要）**：真因＝`resolveMainFileId` 盲信 `cloudState.fileId` 快取；另一台重建主檔後本機 id 失效→備份 PATCH 死 id 失敗、還原下載 404 誤判「沒有備份」，備份時間停在某天。改為**一律以檔名重新解析並更新快取**，查無檔才清快取、列檔失敗才退回快取。使用者診斷證實：檔在(78KB,今天)、帳號一致、只是本機 id 失效。**另發現：課務與智慧記事本共用同一 OAuth client／appDataFolder（有 notebook-backup.json），因檔名不同不衝突，故意不改 client_id 以免 strand 現有備份。**
- **v09.44 專科教室指派引導**：原引導只在「尚無教室」空狀態出現、建了就消失。改在專科教室標題下**常駐**一行：到③教師配課列(班級→科目→節數→**教室**)最右下拉指派。（教室綁在 teacher.load 的 roomId，非綁科目）
- **v09.45–10.00 代課新功能（大改，使用者確認過設計）**：見下方「代課功能」段。

<details><summary>更早區間（v09.27 → v09.36）＝視覺打磨 + 3 修正</summary>

## 本次區間做了什麼（v09.27 → v09.36）＝視覺打磨 + 3 修正
- **v09.27–30 統一「下陷凹槽面板＋懸浮卡片」設計系統**：①科目(含領域節數摺疊)、②年級與班級(年級摺疊+班級卡)、③教師卡片 全部套用。面板 `.subj-cards/.class-cards/.teacher-cards` 與摺疊 body `.domain-fold-body/.grade-fold-body` 用 inset 內陰影＝凹槽；卡片漸層底+層疊陰影+hover 上浮 −6px。（曾加底部 LED 燈條後移除）
- **v09.31**：③教師卡片區與上下資訊卡拉開 18px。
- **v09.32**：④排課頁「教師已排/應排」拆成獨立卡與課表分開。
- **v09.33**：課表輸出列印/存 PDF 保留底色（`@media print { print-color-adjust:exact }`）。
- **v09.34–35**：排課板未排空格 `.open-empty` 下挖；**導師自編格：空格(released)深挖(淺底#dfeee7)、已填回收平面**。
- **v09.36**：課表 `table-layout:fixed`→週一~五等寬、`.period-th` 84px 最小；.docx 日欄本就等寬不改。
- **行為澄清(未變更)**：「解除鎖定」一律還原自編格+清 selfDone，selfDone 不跨越此邊界；使用者確認維持現狀。
</details>

## 代課功能（v09.45 起，新分頁「代課」）
- **入口**：頂部分頁「課表輸出」右方；`data-tab="subst"`→`viewSubst()`。
- **資料**：`state.substitutions: [{ id, absentTeacherId, date, createdAt, assignments:{'classId|day|period': subTeacherId} }]`。**未動 SCHEMA(仍=2)**，以載入/匯入(line~2589)/還原(applyBackupObject) 三處 guard 補預設，相容既有備份。runtime `substOpenId`＝目前開啟編輯的記錄 id。
- **流程**：＋新增代課→選被代課(請假)教師+日期→調出其課表(`substTimetableHTML`,互動)→點有課格(`subst-cell`)跳空堂教師清單(`substCellPicker`)指派→列印/存 PDF。清單頁可多筆、🗑️刪除(`substDelete`)。
- **空堂判定** `freeTeachersAt(day,period,rec)`：排除當節在上課者(`busyTeachersAt`用 `slotAssignments`)、設不排課時段者(`t.unavailable` 含 `day|period`)、被代課者、同節已被指派為別格代課者。
- **列印組合** `substPrintHTML(rec)`：①被代課者代課課表 ②每位代課者課表(含代課節,`subTeacherTimetableHTML`,代課節標「代課（代 ○○）」) ③每個受影響班級課表(`substClassTimetableHTML`,**代課節只顯示代課教師名、原任課存 title tooltip**)。逐張換頁。`substPrint()` 注入 `.subst-print-area`+`body.printing-subst` 於列印時取代 `#view`。
- **不動實際排課**（`state.slots` 不變），純輸出。
- **CSS**：`.subst-list/.subst-item`、`.subst-offer(.assigned/.need)`、`.subst-print-area/.subst-print-page`（`@media print` break-before:page）；`.subst-offer` 已加入 print-color-adjust 清單。

<details><summary>更早區間（v09.18 → v09.26，介面大改版 + 2 修正）</summary>

## 本次區間做了什麼（v09.18 → v09.26）＝介面大改版 + 2 修正
- **v09.19 頂部分頁改分段式膠囊切換器**（參考阿剛老師「剛好系列」blog 版面；純 CSS `.tabs`）。
- **v09.20 ①科目**：領域節數併入①（`.domain-fold` 摺疊 + `state.domainsConfirmed` 完成閘門，既有科目者視為已完成）；科目改**卡片**(`.subj-card`)。
- **v09.21 ②年級與班級**：合併年級+班級（年級設定=`gradeFold()` 摺疊、班級=卡片）；**步驟全面重編號 ①②③④**（④教師→③、⑤排課→④，全檔~80 處圈號腳本重編；`data-tab` 鍵不變、`F③`/help 三重點清單保留）。
- **v09.22**：卡片精簡（班級卡首列僅班名+代號、次列僅科目/節數）＋**班級「編輯」與「課程/協同」合一**（單一 classModal）＋科目/班級卡改**近方形**。
- **v09.23 ③教師改卡片**（`.teacher-card`；上方配課檢查卡+下方配課矩陣保留）。
- **摺疊狀態保持**：`subjDomainOpen`/`gradeFoldOpen` + `toggle` 捕獲監聽。
- **v09.24 列印/存PDF 隱藏狀態圖示**：🔒🔗👥✂️🧩 包 `.cell-flag`，`@media print` 隱藏 `.cell-flag`/`.lock-mark`（螢幕照舊）。
- **v09.25 修正**：分節科目(✂️)導師自編**收回合併後變「未指定老師」**→ `mergeFillFile` + `pick-selfcourse` 補 `slotTeachers[key]=本班導師id`。**舊資料需重收回/重點一次才補**。
- **v09.26 科目文字色**：科目加 `textColor`（modal 底色+文字色雙票+預覽）＋`subjTextColor(s)`（未設→`textOn` fallback）；全面套用色塊處；`.docx` 單色不受影響。
</details>

<details><summary>更早區間（v08.05 → v09.11，已上線）</summary>

## 本次區間做了什麼（v08.05 → v09.11）
- **v09.00 導師自編四調整**：①自編選課走協同連動（pick/clear 同步夥伴班同格）②解除鎖定回復原排課（`selfBackup` 備份、`restoreSelfCells`）③**✅導師自編完成**（`state.selfDone`，驗證無空格+無衝堂才鎖；協同科連動鎖夥伴班該格；`selfCellTeacherLocked` 衍生雙向連動；夥伴班仍須各自按完成）④**🔓解鎖導師自編**（排課者清 selfDone）。
- **v09.01 全校配課檢查閘門（防呆）**：④教師「檢查全校配課」通過（含**每班須設級任導師**）才解鎖 ⑤排課；`staffingSignature/staffingConfirmed`，資料一改即需重按。根因＝使用者遇「導師沒設導師班→自編偵測不到、一鍵鎖定沒釋放」。
- **v09.02–09.08 F③ 導師線上填課（方案A，drive.file+Picker）**：
  - 填課包契約 `buildFillFile`/`mergeFillFile`（course-fill-1，只依 content set + 只依明確 `cleared` 清）。
  - 排課者：⑤鎖定後「☁️線上填課」開放（建資料夾+每班檔+逐位 email 分享 writer）/收回合併，給可寄的 `?fill=1` 連結。
  - 導師 **kiosk**：`?fill`→隱藏分頁、**整張課表 grid** 點🧩選課、🔒已固定唯讀；離開＝結束畫面不進系統（`fillLinkMode`/`fillEnded`，防竄改）。
  - **Google 帳號綁定**：`homeroomEmail` 比對登入帳號，只能開自己班；移除「選其他班級檔」。
  - 檔名 `class-<schoolCode><學年><年級><班code>`；③班級加**數字代號**、設定加**學校代號**（多校區隔）。`GOOGLE_API_KEY`/Picker API 已設。
- **v09.06** 分節科目導師可自編節數修正（`selfCourseLocked` 只算導師本人任教格）。
- **v09.10** 連堂支援奇數：科目「連堂次數（對數）」`consecutivePairs`+`consecutiveTarget`，剩餘單堂不算錯。
- **v09.11（ROADMAP G-Tier1）** 跨學年一鍵沿用（設定「🗓️學年度轉換」）+ 排課 Undo/Redo（Ctrl+Z/Y，鎖定為邊界）。
- **v09.04** 使用說明全面重整（後續版本持續同步）。
</details>

## 下一步（可挑）
- ~~F③ live 真機驗證~~ **✅ 已完成（2026-08-11，實際帳號往返無問題）**。
- **ROADMAP G-Tier2**：全校總表+PNG（=D）、F③ 填課進度總覽（誰交/未交+一鍵全收）、④配課矩陣檢視。
- **G-Tier3**：首頁儀表板、範例資料、自動排課局部重排、連堂進階 pattern、docx 領域合併 legend、久未備份提醒。

## 待決 / 卡住的問題
- **（已清）受影響班級課表代課節「代課：」殘留**：實為舊 SW 快取，v10.00 部署+更新後只顯示代課教師名，使用者 2026-08-27 已確認解決。程式碼 app.js:2513。
- **雲端同步修復待使用者實機驗證**：v09.43 已修 `resolveMainFileId`；請使用者在「卡在 8/13 的那台」更新到 v10 後，先「⬇️從雲端還原→最新」拉回 8/26 版，再「⬆️立即備份」確認時間前進到今天。🔍診斷按鈕可留著或日後移除。
- **代課功能未寫「使用說明」**：已向使用者提過可補一段，尚未做；使用者未回覆要不要。
- **（已清）F③ live 與雲端同步 live 真機往返**：2026-08-11 實際帳號驗證通過。

## 注意事項（給另一台的 Claude）
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
- 版本 vNN.MM：`APP_VERSION`(app.js)＋sw `CACHE_NAME` 必須同步。小改直接 bump minor、大改先確認。現 **v10.00**。
- **UI 現況（v09.19–26）**：分頁 ①科目·②年級與班級·③教師·④排課·課表輸出·設定；科目/班級/教師皆卡片式；`data-tab` 鍵未變（render `case 'grades':case 'classes'`→`viewGradesClasses()`）。改 UI 前先看架構記憶的「v09.19–26 介面大改版」段。
- **測試 app.js 後務必先清 SW 快取再 navigate**（否則跑舊碼）；量有 transition 的 CSS 前先關 transition（預覽窗凍結假象）。
- **GH Pages 部署偶發逾時**（本輪 v09.03 卡約 3 小時）→ **推一個空 commit 重新觸發**即可，非程式問題。改版後可 curl `https://calvincat-ship-it.github.io/course-scheduler/app.js` 確認線上版本。
- F③ 關鍵：`fillTokenClient`(drive.file，與 v07 appdata token 分開)、`buildFillFile/mergeFillFile`、`homeroomEmail`(綁定)、`fillFileName`(schoolCode)、`fillLinkMode/kioskFill`(kiosk)。
- 自編/鎖定關鍵：`isSelfSlot`、`finalizeLock`、`selfCellTeacherLocked`、`selfCourseTarget`(分節只算導師本人)、`state.selfCells/selfDone/selfBackup`。
- 排課引擎改動後回歸測：衝堂/連堂(consecutiveTarget)/協同/分節/Undo。
