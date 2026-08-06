# 交接筆記 (HANDOFF)

> 收工時 Claude 更新這裡；開工時 Claude 先讀這裡。跟程式碼一起 git 同步。

## 最後更新
- 時間：2026-08-07 凌晨（使用者休息，Claude 自主處理上線）
- 機器：筆電
- 版本：**main = v04.01（已成功上線並線上實測通過）**。schema 仍為 2、向下相容。
- 狀態：v04.00→v04.01 自動排課功能全部完成、本機＋**線上**實測通過、0 衝堂、無 console error。

## 本次 session 做了什麼（v03.00 → v04.01）
### v04.00 — App 內通用自動排課（選用）
- ⑤排課「🪄 自動排課」按鈕：靜態緊度排序＋貪婪 MRV，尊重所有硬約束（教師/教室衝堂、不排課、協同同步、連堂、分節、年級節次、每科填滿）＋科目「🔒 排課限制」（限定上課日／節次白名單）。清空重排/只補空格；排不下列表回報；不製造衝堂。
- 外部 CP-SAT 專屬流程保留不動。

### v04.01 — 自動排課進階（使用者四項全選）
- **硬約束**：科目「每天最多1節(distinctDays)」「兩節不排相鄰兩天(gapDays)」；教師單日節數上限（設定頁全域 settings.maxLessonsPerDay、教師個別覆寫 teacher.maxPerDay、科目 excludeDailyCap 豁免如母語）。
- **軟性偏好**（隨機重啟中取最佳）：教師每日節數平衡、上午避免湊滿、科目偏好時段 preferBand(上午/下午)、同科分散不同天。cellSoftScore 挑格 + scoreSolution 全域罰分。
- **求解器**：runAutoSchedule 改隨機重啟（時間預算 2.5s／最多 300 趟），保留「排最多、其次品質分最低」的最佳解；結果 modal 顯示嘗試趟數與品質分。
- UI：科目 modal 進階區、教師 modal 單日上限、設定頁全域上限。
- 待辦清單在 `ROADMAP.md`（半自動建議 / Google Drive 同步 / 領域節數表 / 總表PNG / 自動排課更進階項如第七節輕科、社自2+1、指定節偏好、回溯求解）。

## GitHub Pages 部署事件（2026-08-06→07）
- v04.00 起（run #21）連續數次 Pages **deploy 步驟逾時**（"Timeout reached, aborting!"，~10m52s）——**非程式問題**（build 每次成功、artifact 正常）；GitHub 官方狀態全綠，研判為該 repo Pages 部署暫時卡住/塞佇列。
- 處理：等約 1 小時後推空 commit 重新觸發（重試#1）→ **成功**，線上翻新到 v04.01。線上端到端實測（注入小情境自動排課）：排滿、0 衝堂、偏好生效、已清除測試資料。
- 過程留下幾個空 chore commit（重新觸發用），無害；不值得 force-push 清理。

## 下一步
- （無待接續工作。）可從 ROADMAP.md 挑下一項；或使用者實際用真實資料測自動排課後回饋再調。

## 待決 / 卡住的問題
- （無）。提醒：若日後又遇 Pages deploy 逾時，多為 GitHub 端暫時性，隔一陣子推一次即可；或到 Actions「Re-run failed jobs」。

## 注意事項（給另一台的 Claude）
- **memory 尚未更新**：本 session v04.00/v04.01 的架構重點還沒寫進 claude-sync 記憶檔（等使用者「收工」時列項確認再寫）。project_course_scheduler_architecture 目前停在 v03.00。
- 自動排課核心：`runAutoSchedule`(隨機重啟)、`greedyRun`、`canPlaceAt`(含新硬約束)、`cellSoftScore`/`scoreSolution`(軟性)、`teacherDailyCap`/`teacherDayLoad`(單日上限)、`isMorningPeriod`(start<'12:00')。科目新欄位 lockDays/lockPeriods/distinctDays/gapDays/preferBand/excludeDailyCap 皆為 optional、缺省安全。
- 版本 vNN.MM：APP_VERSION(app.js)＋sw CACHE_NAME 同步。現 v04.01。
- 開工先 sync-start、收工必 sync-end；不要兩台同時改同一個檔。
