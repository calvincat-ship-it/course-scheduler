# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-09 收工
- 機器：桌機
- 版本：**main = v08.05（已上線）**。schema 仍為 2、向下相容。
- 狀態：全部本機實測通過、無 console error、已 push main（GH Pages 自動部署）。

## 本次區間做了什麼（v05.01 → v08.05）
- **v06.00 領域節數**：新分頁「領域節數」。`state.domains`（108 課綱國小起始值、務必校對）＋科目 `domainId`。建議節數參考表（可編輯）＋各年級「實配 vs 建議」對照矩陣（未指定領域列「未分類」）。
- **v07.00/07.01 Google Drive 雲端同步**：設定頁「☁️ 雲端同步」。移植血壓 App 的 GIS token＋Drive REST；整份 state 備份到自己雲端 appDataFolder。自動備份(save() choke、debounce 8s)、多裝置開 App 較新即詢問還原、還原版本選擇器(最新＋每日歷史7)、更換帳號隔離。**GOOGLE_CLIENT_ID 為本 App 專屬 OAuth 用戶端(v07.01 已填)**。⚠️ **live Drive/OAuth 往返未真機測**（我不能代登入），請自行實機測「連結→備份→另一台還原」。
- **v08.00→08.05 自編課程＋鎖定（為「導師線上填課」鋪路，完整設計見 `DESIGN_F.md`）**：
  - 自編判定**改為系統自動**（v08.03 捨棄手動旗標）：`isSelfSlot`＝該格所有授課老師皆同年級級任導師（單師須本班導師）。
  - 鎖定兩種：🔒一鍵、🎯單格（逐格選→完成鎖定，自編格不可鎖、即時 🧩 預覽）。
  - 完成鎖定→自編格釋放為空白→導師從「本班導師的配課科目」選課、**追蹤節數**。
  - v08.04 即時 🧩 預覽＋單格排除自編；**v08.05 修 finalizeLock 凍結 bug**（導師班晚設時一鍵全鎖）→改每次即時重判、保護導師已選。

## 下一步（使用者收工前停在這）
- **F③ 導師線上填課「線上分享」**（唯一未做的大塊）：導師用學校 Google 登入、每班一個共享 Drive 檔各填各班、排課人員收回合併。需先細化 `drive.file`＋Google Picker、資料夾分享 UX、收回衝突呈現——**動工前讀 `DESIGN_F.md` ③ 段**。本機選課 picker 已完成，只差線上分享。
- 其他 ROADMAP：D 全校總表/PNG、自動排課更進階項。

## 待決 / 卡住的問題
- 雲端同步的 live Drive/OAuth 往返尚未真機驗證（本機非網路部分已測）。
- （自編/鎖定使用者已實測確認判定正確、單格與一鍵鎖定 v08.05 後皆只鎖非自編。）

## 注意事項（給另一台的 Claude）
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
- 版本 vNN.MM：APP_VERSION(app.js)＋sw CACHE_NAME 必須同步。小改直接 bump minor、大改先確認。現 **v08.05**。
- 雲端 OAuth 用戶端是 course-scheduler **專屬**（appDataFolder 每用戶端獨立、不可與血壓/記事本共用）。
- 自編/鎖定關鍵：`isSelfSlot`(判定)、`finalizeLock`(每次即時重判、保護導師已選)、`state.selfCells`。改動排課引擎後要回歸測這幾條。
