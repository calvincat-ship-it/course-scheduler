# 課務編排 v02 重構設計（redesign 分支）

> 大幅流程重構，各步驟前後參照。**開發期間不 push main、不部署**；只在本機 preview 測試。全部完成並經使用者確認後才合併 main 上線。主線 main 維持 v01.05（同仁使用中）。

## 使用者決定
- 年段＝**六個年級**（一~六年級），固定 6 組。
- 現有資料**全部清空重來**（schema 2；載入舊 v01 資料即重置為預設）。

## 新流程（前後參照）
1. **科目**：name、color、**allowGrouping（可分組教學）**。允許分組的科目：配課不計教師衝堂、排課可把分組老師放同一節。
2. **年級（6 固定）**
   - 2.1 **節次表**：全域「節次定義」(label/start/end/isBreak)；每個年級各自為「每節 × 每個上課日」勾選是否上課（grade.periodDays）。
   - 2.2 **科目節數卡**：每年級一張，勾選開的科目並填一周節數。該年級 Σ科目節數 必須 == 該年級可用節格數（節次表勾選總數）才算完成／可進下一步。
3. **班級**：選年級 → 課程（科目+節數）強制沿用該年級 2.2 設定。可設**協同教學**：預設可協同對象＝同年級+同科目的其他班；協同班級科目彼此不計教室衝堂。
4. **教師**
   - 4.1 姓名、身分別、每周授課時數、不排課時段。
   - 4.2 **教師配課**：班級下拉→該班科目下拉→填時數；儲存時檢查該師配課節數 Σ == 每周授課時數，不符則警示且不接受。
   - 4.3 **全部教師確認**：交叉檢核各班每科節數是否缺漏/超過（分組視為同一節，不重複計）；不符列出（班級+科目+目前教師）並擋下一步。
5. **排課**：沿用現行盤面（分組老師放同一節、協同同步、連堂自動成對）。

## 資料模型（state, schema:2, 目標 v02.00）
```
settings: { days:[1..5], periods:[{id,label,start,end,isBreak}], autoPairConsecutive:true }
subjects: [{id,name,color,allowGrouping}]
grades:   [{id,name, periodDays:{periodId:[dayNums]}, subjectHours:[{subjectId,hours}]}]  // 6 固定 g1..g6
classes:  [{id,name,gradeId, coteach:[{subjectId, partnerClassIds:[...]}]}]
teachers: [{id,name,type,weeklyHours,unavailable:[...], load:[{classId,subjectId,hours}]}]
slots:    { 'classId|day|period' : subjectId }   // 排課：格子放「科目」；老師由 teacher.load 推得
helpSeen, schema:2
```
- 一格開放與否＝該班「年級」的 periodDays 決定。
- 某(班,科)的老師＝所有 teacher.load 中 classId+subjectId 相符者；allowGrouping 科目可多位＝分組。

## 分批 (batch) 進度
- [進行中] **Batch 1**：模型重置 + 設定(上課日/節次定義/選項) + 科目(allowGrouping) + 年級(節次表 grid + 科目節數卡 + 節數檢核)。其餘分頁暫 stub。
- [x] Batch 2：班級（選年級→強制課程；協同設定，per-subject group id 對稱）。
- [x] Batch 3：教師 + 教師配課(4.2 個別 Σ==每周授課才可存) + 全校交叉檢核(4.3, 分組不重複計)。
- [x] Batch 4：排課改版（slot=科目、老師由 load 推得、分組同格、協同同步+豁免、連堂成對）＋課表輸出（班級/教師/CSV/列印）。教室概念已移除。連堂改 subject.consecutive。
- [x] Batch 5：排課硬性閘門(配課未齊擋下)、使用說明(App 內+使用說明.md 改寫新流程)、首次自動彈說明、移除 stub、全流程本機測試通過。
  → **等使用者本機驗收，OK 後才 merge main 上線**（改 sw 已是 v02.00；合併 redesign→main、push、Pages 生效）。

## 注意
- 版本 v02.xx 與 sw CACHE_NAME 同步；但 **redesign 期間不 push、不部署**。
- 每個 batch 完成即本機 commit（redesign 分支）以利額度中斷續跑；勿 merge/push main。
