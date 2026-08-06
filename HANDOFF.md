# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-07 收工
- 機器：筆電
- 版本：**main = v05.01（已上線）**。schema 仍為 2、向下相容。
- 狀態：全部本機實測通過、無 console error、已 push main。v05.00 線上實測過；v05.01 已 push（GH Pages 自動部署）。

## 本次區間做了什麼（v03.00 → v05.01）
- **v04.00 App 內通用自動排課（選用）**：⑤排課「🪄 自動排課」；靜態緊度+貪婪 MRV、尊重所有硬約束+科目排課限制、清空重排/只補空格、排不下回報、不製造衝堂。
- **v04.01 自動排課進階**：硬約束(distinctDays/gapDays、教師單日上限 maxPerDay/maxLessonsPerDay、科目 excludeDailyCap)+軟性偏好(每日平衡/上午不滿堂/preferBand/分散)+隨機重啟求解(取最佳)。
- **v05.00 半自動排課建議（手排輔助）**：①空格建議(未選科目點空格→可放清單一鍵放入)②🔧喬課(排不下的單純科目→findEvictionChain 同班內回溯調課連鎖≤3步→一鍵套用保0衝堂)。修 canPlaceAt day 字串/數字 bug。
- **v05.01 級任導師班**：教師身分=級任時可設 homeroomClassId（供之後功能用）；列表顯示🎓、刪班清理。

## GitHub Pages 部署提醒
- v04→v05 期間曾遇 `deploy` 步驟連續逾時（"Timeout reached"，非程式問題，build 都成功、status 全綠）。處理：等一陣子推空 commit 重新觸發、或 Actions「Re-run failed jobs」；失敗不影響現有線上版。v04.01→v05.00 是隔約1小時重推才成功；v05.00、v05.01 之後恢復正常一次就過。

## 下一步
- （無待接續工作。）**使用者提到 v05.01 導師班設定是為「之後想開發的某項功能」鋪路**——下次可能會接著開發那項（尚未說明是什麼）。
- 其他可挑 repo `ROADMAP.md`：B Google Drive 同步、C 領域節數參考表、D 全校總表/PNG、自動排課更進階（第七節輕科/社自2+1/指定節偏好/跨班調課連鎖/回溯求解）。

## 待決 / 卡住的問題
- （無）。

## 注意事項（給另一台的 Claude）
- memory 已更新到 v05.01（project_course_scheduler_architecture / reference / MEMORY.md 索引）。
- 自動排課核心 `runAutoSchedule`/`canPlaceAt`/`cellSoftScore`/`scoreSolution`；半自動 `suggestionsForCell`/`findEvictionChain`(state-preserving)/`placeWithExtras`；導師班 `teacher.homeroomClassId`。踩雷：canPlaceAt 開頭要 parseInt(day)。
- 版本 vNN.MM：APP_VERSION(app.js)＋sw CACHE_NAME 同步。現 v05.01。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
