# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-11 收工
- 機器：（本次 session 的機器；Desktop\claude code）
- 版本：**main = v09.26（已上線）**。schema 仍為 2、向下相容（textColor 等新欄位皆 optional）。
- 狀態：全部本機實測通過、無 console error、已 push main（GH Pages 已部署 v09.26）。

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
- **F③ live 真機驗證**（唯一待驗，我不能代做）：需 ≥2 個 Google 帳號測「排課者開放分享 → 導師 ?fill 登入 Picker 填 → 收回合併」；帳號綁定（他班檔打不開）。若分享報 `share_failed` → 改 `drive` scope（我 10 秒可改）。
- **ROADMAP G-Tier2**：全校總表+PNG（=D）、F③ 填課進度總覽（誰交/未交+一鍵全收）、④配課矩陣檢視。
- **G-Tier3**：首頁儀表板、範例資料、自動排課局部重排、連堂進階 pattern、docx 領域合併 legend、久未備份提醒。

## 待決 / 卡住的問題
- **F③ live OAuth/Drive/Picker/跨帳號往返尚未真機驗證**（本機非網路邏輯全測過）。
- 雲端同步（v07）live 往返亦尚未真機驗證。
- 使用者已確認：導師自編四調整、全校配課閘門、連堂奇數、分節導師節數、跨學年沿用、Undo/Redo 本機皆正確。

## 注意事項（給另一台的 Claude）
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
- 版本 vNN.MM：`APP_VERSION`(app.js)＋sw `CACHE_NAME` 必須同步。小改直接 bump minor、大改先確認。現 **v09.26**。
- **UI 現況（v09.19–26）**：分頁 ①科目·②年級與班級·③教師·④排課·課表輸出·設定；科目/班級/教師皆卡片式；`data-tab` 鍵未變（render `case 'grades':case 'classes'`→`viewGradesClasses()`）。改 UI 前先看架構記憶的「v09.19–26 介面大改版」段。
- **測試 app.js 後務必先清 SW 快取再 navigate**（否則跑舊碼）；量有 transition 的 CSS 前先關 transition（預覽窗凍結假象）。
- **GH Pages 部署偶發逾時**（本輪 v09.03 卡約 3 小時）→ **推一個空 commit 重新觸發**即可，非程式問題。改版後可 curl `https://calvincat-ship-it.github.io/course-scheduler/app.js` 確認線上版本。
- F③ 關鍵：`fillTokenClient`(drive.file，與 v07 appdata token 分開)、`buildFillFile/mergeFillFile`、`homeroomEmail`(綁定)、`fillFileName`(schoolCode)、`fillLinkMode/kioskFill`(kiosk)。
- 自編/鎖定關鍵：`isSelfSlot`、`finalizeLock`、`selfCellTeacherLocked`、`selfCourseTarget`(分節只算導師本人)、`state.selfCells/selfDone/selfBackup`。
- 排課引擎改動後回歸測：衝堂/連堂(consecutiveTarget)/協同/分節/Undo。
