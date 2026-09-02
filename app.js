'use strict';

/* ==========================================================================
   課務編排 v02（redesign）— 前後參照流程
   科目 → 年級(節次表+科目節數) → 班級 → 教師(配課) → 排課
   資料層：IndexedDB 單一 state 文件（schema:2）
   ========================================================================== */

const APP_VERSION = 'v12.07';
const DB_NAME = 'course_scheduler';
const STATE_KEY = 'state';
const SCHEMA = 2;

/* ---------- 雲端同步（Google Drive appDataFolder）常數 ----------
   GOOGLE_CLIENT_ID：需在 Google Cloud Console 為「本 App」建立專屬 OAuth 用戶端
   （drive.appdata scope 的隱藏資料夾是「每個 OAuth 用戶端各自獨立」，不可與血壓/記事本共用，
   否則備份檔會混進別的 App 資料夾）。授權的 JavaScript 來源需含：
     https://calvincat-ship-it.github.io   （正式：GitHub Pages）
     http://localhost:5177                  （本機測試）
   設定好後把用戶端 ID 貼到下面即可啟用；留空時雲端同步顯示「尚未設定」。 */
const GOOGLE_CLIENT_ID = '682239566772-mp9bofvp17baa7487rja86et1fud6rmu.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CLOUD_KEY = 'course_cloud_v1';         // localStorage：雲端連線狀態（與 IDB 的 state 分開）
const CLOUD_FILE_NAME = 'course-backup.json';
const CLOUD_PREV_NAME = 'course-backup.prev.json';
const CLOUD_HISTORY_PREFIX = 'course-history-';
const CLOUD_DEBOUNCE_MS = 8000;

/* ---------- F③ 導師線上填課（Google Drive drive.file + Picker）常數 ----------
   排課者用 drive.file 建共享資料夾＋每班檔、逐位導師 email 分享；導師用 Picker 開自己班的檔填課。
   GOOGLE_API_KEY 為 Picker 專用（前端公開）。金鑰在 Cloud Console 的「應用程式限制」設為
   ⚠️「無」（不要改回「網站/HTTP referrer」限制！）＋「API 限制＝只限 Google Picker API」。
   原因：HTTP referrer 限制天生不可靠——Brave/Firefox 強化保護、擋廣告/隱私擴充套件、手機 App 內建
   瀏覽器、加到主畫面的 PWA 都會清掉 Referer，導致 Picker 報「The API developer key is invalid」擋掉
   老師（2026-08-31 線上代課填報實機踩雷）。安全性靠：此金鑰只能呼叫 Picker API，且每次開檔都仍需
   老師本人 OAuth token，金鑰外洩也無用。
   GOOGLE_PROJECT_NUMBER 為 Picker 的 appId（即 client_id 開頭那串）。 */
const GOOGLE_API_KEY = 'AIzaSyCobl3vcBm8sgeieam7TWMf_LtC4ld3esM';
const GOOGLE_PROJECT_NUMBER = '682239566772';
const FILL_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILL_FOLDER_PREFIX = '課務-自編填課-';

const DAY_LABELS = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const GRADE_NAMES = ['一年級', '二年級', '三年級', '四年級', '五年級', '六年級'];
const TEACHER_TYPES = ['級任', '科任', '兼行政'];
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48'];

/* ---------- IndexedDB kv ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => { const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

/* ---------- State ---------- */
let state = null;

/* 雲端同步 runtime（cloudState 存 localStorage；其餘僅記憶體） */
let cloudState = loadCloudState();
let suppressCloud = false;   // 還原期間設 true，避免還原後又立即上傳覆蓋來源
let gisToken = null;         // { access_token, expiresAt } 僅記憶體、不落地
let tokenClient = null;
let cloudTimer = null;
let cloudBusy = false;
let snapshotInFlight = false;
let _tokResolve = null, _tokReject = null;
// v10.05 開 App 自動查雲端的迴圈防護：進行中旗標 + 本 session 失敗即停 + 節流時間戳。
let cloudCheckInFlight = false, cloudAutoDisabledThisSession = false, cloudLastCheckAt = 0;

function defaultPeriods() {
  return [
    { id: 'p1', label: '第1節', start: '08:40', end: '09:20', isBreak: false },
    { id: 'p2', label: '第2節', start: '09:30', end: '10:10', isBreak: false },
    { id: 'p3', label: '第3節', start: '10:30', end: '11:10', isBreak: false },
    { id: 'p4', label: '第4節', start: '11:20', end: '12:00', isBreak: false },
    { id: 'lunch', label: '午休', start: '12:00', end: '13:20', isBreak: true },
    { id: 'p5', label: '第5節', start: '13:30', end: '14:10', isBreak: false },
    { id: 'p6', label: '第6節', start: '14:20', end: '15:00', isBreak: false },
    { id: 'p7', label: '第7節', start: '15:20', end: '16:00', isBreak: false },
  ];
}
/* 領域節數參考表（108 課綱 國小 每週領域學習節數）預設起點，數字可於「領域節數」頁編輯、務必依課綱／貴校校對。
   hours = [一,二,三,四,五,六] 年級建議節數。 */
function defaultDomains() {
  const D = (name, hours) => ({ id: uid(), name, hours });
  return [
    D('國語文', [6, 6, 5, 5, 5, 5]),
    D('本土/新住民語文', [1, 1, 1, 1, 1, 1]),
    D('英語文', [0, 0, 1, 1, 2, 2]),
    D('數學', [4, 4, 4, 4, 4, 4]),
    D('生活課程', [6, 6, 0, 0, 0, 0]),
    D('社會', [0, 0, 3, 3, 3, 3]),
    D('自然科學', [0, 0, 3, 3, 3, 3]),
    D('藝術（藝文）', [0, 0, 3, 3, 3, 3]),
    D('綜合活動', [0, 0, 2, 2, 3, 3]),
    D('健康與體育', [3, 3, 3, 3, 3, 3]),
    D('彈性學習', [2, 2, 3, 3, 4, 4]),
  ];
}

function defaultState() {
  const days = [1, 2, 3, 4, 5];
  const periods = defaultPeriods();
  const grades = GRADE_NAMES.map((name, i) => {
    const periodDays = {};
    periods.filter(p => !p.isBreak).forEach(p => { periodDays[p.id] = days.slice(); });
    return { id: 'g' + (i + 1), name, periodDays, subjectHours: [] };
  });
  return {
    schema: SCHEMA,
    version: APP_VERSION,
    settings: { days, periods, reportSchool: '', reportYear: '', schoolCode: 'msd9', subjectMap: {} },
    domains: defaultDomains(),
    subjects: [],
    rooms: [],
    grades,
    classes: [],
    teachers: [],
    slots: {},
    slotTeachers: {}, // 分節上課科目：每格記錄該節由哪位老師上（key 同 slots）
    slotContent: {},  // v08.00 自編課程：每個自編格的內容文字（導師填），key 同 slots
    locked: false,        // v08.01 一鍵全鎖：定稿後非自編格全唯讀
    lockedCells: [],      // v08.02 單格鎖定：個別鎖定的格 key 清單
    lockFinalized: false, // v08.02 鎖定已完成（一鍵或單格）→ 自編格釋放、開放導師選課
    selfReleased: false,  // v08.02 自編格是否已釋放為空白（只在首次完成鎖定時清一次）
    selfCells: [],        // v08.03 完成鎖定時系統偵測出的自編格 key（級任導師任課）
    selfBackup: {},       // v09.00 釋放自編格前的原排課備份（key→{sid,tid}），解除鎖定時還原
    selfDone: {},         // v09.00 導師自編完成：classId→true（該班自編格鎖定唯讀）
    staffingOkSig: '',    // v09.01 「檢查全校配課」通過時的資料簽章（含導師設定）；資料一變即需重新檢查
    fillShare: null,      // v09.03 F③ 線上填課分享：{ folderId, folderLink, year, files:{classId:{fileId,link,email}}, openedAt }
    substitutions: [],    // v09.45/v10.06 代課安排：[{ id, absentTeacherId, startDate, endDate, date(舊/相容), createdAt, assignments:{'classId|day|period':subTeacherId} }]
    substDeleted: [],     // v10.12 已刪除代課記錄 id 墓碑：收回時略過，避免線上殘留資料被再度合併回來
    substShare: null,     // v10.01 線上代課填報分享：{ fileId, link, domain, openedAt }
    helpSeen: false,
    setupSeen: false,   // v10.19 全新安裝初次設定精靈（校名/學年度/學校代號）是否已出現過
  };
}

async function save() { if (substKiosk) return; await idbSet(STATE_KEY, state); scheduleCloudBackup(); maybeDailySnapshot(); }   // v10.01 代課 kiosk 載入的是排課者狀態，不可寫進教師本機/雲端

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function esc(str) { return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const byId = (arr, id) => arr.find(x => x.id === id);
const subjectById = id => byId(state.subjects, id);
const roomById = id => byId(state.rooms, id);
const roomName = id => (roomById(id) || {}).name || '';
const gradeById = id => byId(state.grades, id);
const classById = id => byId(state.classes, id);
const teacherById = id => byId(state.teachers, id);
const subjectName = id => (subjectById(id) || {}).name || '?';
const gradeName = id => (gradeById(id) || {}).name || '?';
const activeDays = () => state.settings.days.slice().sort((a, b) => a - b);
const lessonPeriods = () => state.settings.periods.filter(p => !p.isBreak);
const slotKey = (c, d, p) => `${c}|${d}|${p}`;

// 科目文字色：優先用自訂 textColor，否則依底色自動取黑/白（向下相容：舊科目無 textColor）
function subjTextColor(s, fallbackBg) { return (s && s.textColor) ? s.textColor : textOn((s && s.color) || fallbackBg || '#94a3b8'); }
function textOn(hex) {
  const h = (hex || '#94a3b8').replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1e293b' : '#ffffff';
}
function subjectColor(id) { const s = subjectById(id); return (s && s.color) || '#64748b'; }

/* 年級節次/節數 helpers */
const gradePeriodDays = (g, pid) => (g.periodDays && g.periodDays[pid]) || [];
const gradePeriodHasDay = (g, pid, d) => gradePeriodDays(g, pid).includes(d);
function gradeAvailableSlots(g) {
  let n = 0;
  lessonPeriods().forEach(p => { n += gradePeriodDays(g, p.id).filter(d => state.settings.days.includes(d)).length; });
  return n;
}
const gradeSubjHours = (g, sid) => (g.subjectHours.find(x => x.subjectId === sid) || null);

/* 領域 helpers（v06.00） */
const domainById = id => byId(state.domains, id);
const domainName = id => (domainById(id) || {}).name || '';
const gradeIndex = g => state.grades.indexOf(g);                                       // 0..5 → 一~六
function domainSuggested(d, g) { const i = gradeIndex(g); return (d.hours && d.hours[i]) || 0; }
function gradeDomainActual(g, domainId) {
  return g.subjectHours.reduce((sum, x) => {
    const s = subjectById(x.subjectId);
    return (s && s.domainId === domainId) ? sum + (x.hours || 0) : sum;
  }, 0);
}
function gradeUnmappedHours(g) {
  return g.subjectHours.reduce((sum, x) => {
    const s = subjectById(x.subjectId);
    return (!s || !s.domainId || !domainById(s.domainId)) ? sum + (x.hours || 0) : sum;
  }, 0);
}
function gradeAssignedHours(g) { return g.subjectHours.reduce((s, x) => s + (x.hours || 0), 0); }
function gradeComplete(g) { const a = gradeAvailableSlots(g); return a > 0 && a === gradeAssignedHours(g); }

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2400); }

/* ---------- Modal ---------- */
let modalOnSave = null;
function openModal({ title, body, saveLabel = '儲存', onSave = null, wide = false }) {
  modalOnSave = onSave;
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" data-action="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-action="modal-close">✕</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button class="ghost" data-action="modal-close">取消</button>
          ${onSave ? `<button class="btn" data-action="modal-save">${esc(saveLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;
  const f = $('#modalRoot input, #modalRoot select, #modalRoot textarea'); if (f) f.focus();
}
function closeModal() { $('#modalRoot').innerHTML = ''; modalOnSave = null; }

/* ==========================================================================
   Router
   ========================================================================== */
let currentTab = 'home';
let selectedGradeId = null;
let subjDomainOpen = false;   // ① 科目頁：領域節數摺疊區是否展開（runtime，不持久化）
let gradeFoldOpen = true;     // ② 年級與班級頁：年級設定摺疊區是否展開（runtime，預設展開）
let lockMode = false;   // v08.02 單格鎖定選取模式進行中（runtime，不持久化）
let kioskFill = false;  // v09.05 導師填課 kiosk：隱藏其他分頁、只顯示填課介面（?fill 或導師入口）
let fillLinkMode = false; // v09.07 由填課連結(?fill)進入：離開＝關閉分頁/結束畫面，永不進入系統（防導師誤觸竄改資料）
/* v10.01 代課線上填報 kiosk（?subst）：教師登入→開排課者網域共享的代課檔→看全部、只可新增（不可刪改他人） */
let substKiosk = false, substLinkMode = false, substEnded = false, substFileId = null, substMyEmail = '', substMyName = '';
let substMyTeacherId = '', substNoMatch = false;   // v10.10 教師自助：用登入 email 對應教師本人，只安排自己的代課
let substEditableIds = new Set();   // 本 session kiosk 新建、可編輯/送出的記錄 id（其餘唯讀）
let fillEnded = false;    // v09.07 填課結束畫面旗標
let showLoadMatrix = false; // v09.12 ③教師「班×科配課矩陣」展開狀態（runtime）
let fillProgress = null;    // v09.12 F③ 線上填課進度快取 {classId:{total,filled,submitted,submittedAt}}（runtime，按需重讀）
let substOpenId = null;     // v09.45 代課頁：目前開啟編輯中的代課記錄 id（null＝顯示清單）
let substWeekTab = null;    // v10.16 分週指派目前檢視的週 index（null＝全部週為底）
/* v09.11 排課復原 Undo/Redo：只快照 slots/slotTeachers/slotContent（不跨鎖定/自編結構邊界，故 lock/unlock/finalize 時清空堆疊）*/
let undoStack = [], redoStack = [];
const snapSlots = () => ({ slots: { ...state.slots }, slotTeachers: { ...state.slotTeachers }, slotContent: { ...state.slotContent } });
const restoreSnap = s => { state.slots = { ...s.slots }; state.slotTeachers = { ...s.slotTeachers }; state.slotContent = { ...s.slotContent }; };
function pushUndo() { undoStack.push(snapSlots()); if (undoStack.length > 40) undoStack.shift(); redoStack = []; }
function clearUndo() { undoStack = []; redoStack = []; }
function doUndo() { if (!undoStack.length) { toast('沒有可復原的步驟'); return; } redoStack.push(snapSlots()); restoreSnap(undoStack.pop()); save(); render(); toast('已復原'); }
function doRedo() { if (!redoStack.length) { toast('沒有可重做的步驟'); return; } undoStack.push(snapSlots()); restoreSnap(redoStack.pop()); save(); render(); toast('已重做'); }

/* 鎖定/自編偵測 helpers（v08.03：自編改由系統於鎖定時自動判定）
   自編格＝該格所有授課老師皆為「同年級的級任導師」；單師時該師須為本班導師。 */
function slotAllTeacherIds(key) {   // 本格 + 協同夥伴班同格 的所有授課老師
  const [classId, dayS, period] = key.split('|');
  const sid = state.slots[key]; if (!sid) return [];
  const ids = new Set();
  slotAssignments(key).forEach(a => { if (a.teacherId) ids.add(a.teacherId); });
  const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
  if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid).forEach(p => {
    const pk = slotKey(p.id, dayS, period);
    if (state.slots[pk] === sid) slotAssignments(pk).forEach(a => { if (a.teacherId) ids.add(a.teacherId); });
  });
  return [...ids];
}
function isSelfSlot(key) {
  const sid = state.slots[key]; if (!sid) return false;
  const classId = key.split('|')[0]; const c = classById(classId); if (!c) return false;
  const ids = slotAllTeacherIds(key); if (ids.length === 0) return false;
  const teachers = ids.map(teacherById).filter(Boolean); if (teachers.length !== ids.length) return false;
  for (const t of teachers) {   // 每位授課老師都須為「同年級的級任導師」
    if (t.type !== '級任' || !t.homeroomClassId) return false;
    const hc = classById(t.homeroomClassId); if (!hc || hc.gradeId !== c.gradeId) return false;
  }
  if (ids.length === 1) return teachers[0].homeroomClassId === classId;  // 單師：須為本班導師
  return true;   // 多師/協同：全部同年級級任導師即可
}
const isSelfCell = key => (state.selfCells || []).includes(key);   // 已偵測釋放的自編格
function cellIsLocked(key) {
  if (!state.lockFinalized) return false;
  if (isSelfCell(key)) return false;            // 自編格永遠可（導師選課）
  if (state.locked) return true;                // 一鍵：非自編全鎖
  return (state.lockedCells || []).includes(key); // 單格：僅已選格
}
function finalizeLock() {
  state.lockFinalized = true;
  state.selfBackup = state.selfBackup || {};
  // 每次完成鎖定都「即時重新判斷」自編格（依目前排課），不依賴上一次的結果
  const detected = Object.keys(state.slots).filter(isSelfSlot);
  const prev = new Set(state.selfCells || []);
  // 釋放：新偵測到、且先前不在自編清單的格 → 先備份原排課再清空（供解除鎖定時還原；先前已是自編／已被導師選課者不再清，保護其內容）
  detected.forEach(k => { if (!prev.has(k)) {
    state.selfBackup[k] = { sid: state.slots[k], tid: state.slotTeachers[k] || null };
    delete state.slots[k]; delete state.slotTeachers[k]; delete state.slotContent[k];
  } });
  // 自編清單＝這次偵測到的 ∪ 先前仍成立者（目前仍空白待選、或仍被判為自編）；先前若已被改成非自編課程則剔除
  const detectedSet = new Set(detected);
  const keptPrev = (state.selfCells || []).filter(k => detectedSet.has(k) || !state.slots[k]);
  state.selfCells = [...new Set([...keptPrev, ...detected])];
  state.selfReleased = true;
  clearUndo();   // 鎖定是結構性邊界，復原不跨越
}
// v09.00 解除鎖定時把釋放的自編格還原成鎖定前的原排課，並清掉自編/完成狀態
function restoreSelfCells() {
  const bk = state.selfBackup || {};
  Object.keys(bk).forEach(k => {
    const { sid, tid } = bk[k] || {};
    if (sid) { state.slots[k] = sid; if (tid) state.slotTeachers[k] = tid; }
  });
  state.selfBackup = {};
  state.selfCells = [];
  state.selfDone = {};
  state.selfReleased = false;
  clearUndo();   // 解除鎖定是結構性邊界，復原不跨越
}
// v09.00 協同：某自編格（含 sid）在其他班同日同節、共用同一協同群組的夥伴格 key
function coteachPartnerCells(key) {
  const [classId, day, period] = key.split('|');
  const sid = state.slots[key]; if (!sid) return [];
  const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
  if (!gid) return [];
  return state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid)
    .map(p => slotKey(p.id, day, period))
    .filter(pk => isSelfCell(pk));   // 只連動同為自編格的夥伴
}
// v09.00 此自編格是否被「導師自編完成」鎖住：本班已完成，或協同夥伴班已完成（連動鎖定）
function selfCellTeacherLocked(key) {
  if (!isSelfCell(key)) return false;
  const classId = key.split('|')[0];
  if (state.selfDone && state.selfDone[classId]) return true;
  return coteachPartnerCells(key).some(pk => state.selfDone && state.selfDone[pk.split('|')[0]]);
}
// v09.00 某班的所有自編格 key
function classSelfCells(classId) { return (state.selfCells || []).filter(k => k.split('|')[0] === classId); }
// v09.00 導師自編完成前驗證：所有自編格已填 且 無衝堂；回傳 {ok, reason}
function validateSelfEdit(classId) {
  const cells = classSelfCells(classId);
  if (!cells.length) return { ok: false, reason: '本班沒有自編格' };
  const empty = cells.filter(k => !state.slots[k]).length;
  if (empty) return { ok: false, reason: `尚有 ${empty} 個自編格未選課` };
  const conflicts = computeConflicts();
  const bad = cells.filter(k => conflicts[k]).length;
  if (bad) return { ok: false, reason: `有 ${bad} 個自編格衝堂／未同步，請先排除` };
  return { ok: true };
}
// 導師選課候選＝本班級任導師在本班的配課科目；並追蹤各科節數
function homeroomTeacher(classId) { return state.teachers.find(t => t.homeroomClassId === classId) || null; }
function selfCoursePool(classId) {
  const hr = homeroomTeacher(classId); if (!hr) return [];
  const sids = [...new Set((hr.load || []).filter(L => L.classId === classId).map(L => L.subjectId))];
  return sids.map(subjectById).filter(Boolean);
}
function selfCourseRequired(classId, sid) { const hr = homeroomTeacher(classId); const L = hr && (hr.load || []).find(x => x.classId === classId && x.subjectId === sid); return L ? L.hours : 0; }
function selfCoursePlaced(classId, sid) { return (state.selfCells || []).filter(k => k.split('|')[0] === classId && state.slots[k] === sid).length; }
// v09.06 該(班,科)已排在「非自編格」、且「本班導師實際任教」的節數（分節科目只算導師教的那幾節，不含科任/其他老師分攤的節數）
function selfCourseLocked(classId, sid) {
  const hr = homeroomTeacher(classId); if (!hr) return 0;
  let n = 0;
  for (const k in state.slots) {
    if (k.split('|')[0] !== classId || state.slots[k] !== sid || isSelfCell(k)) continue;
    if (slotAssignments(k).some(a => a.teacherId === hr.id)) n++;   // 只計導師本人任教的鎖定格
  }
  return n;
}
function selfCourseTarget(classId, sid) { return Math.max(0, selfCourseRequired(classId, sid) - selfCourseLocked(classId, sid)); }
// v09.05/09 線上填課檔名：class- + 學校代號 + 學年度 + 年級數 + 班級數字代號（學校代號/學年度取自設定/課表輸出格式）
function classGradeNum(c) { const i = state.grades.findIndex(g => g.id === c.gradeId); return i >= 0 ? i + 1 : ''; }
function fillFileName(c) { const s = state.settings || {}; return `class-${s.schoolCode || 'msd9'}${s.reportYear || ''}${classGradeNum(c)}${c.code || ''}`; }

/* ---------- F③ 導師線上填課：檔案契約（排課者↔導師共用的「填課包」格式） ----------
   排課者鎖定後為每班產生 course-fill-1 包（自編格＋候選科目池＋唯讀課表快照＋目前內容），
   分享給該班導師；導師填完回存；排課者收回時 mergeFillFile 合併回課表（協同同步＋衝堂偵測）。 */
const FILL_FMT = 'course-fill-1';
function buildFillFile(classId) {
  const c = classById(classId); const hr = homeroomTeacher(classId); const g = classGrade(c);
  const cells = classSelfCells(classId);
  // 候選科目池：目標＝應排 − 已鎖（扣除與科任協同等已鎖定不開放的節數）；目標為 0 者不列
  const pool = selfCoursePool(classId).map(s => ({ sid: s.id, name: s.name, color: s.color, textColor: s.textColor || '', required: selfCourseTarget(classId, s.id) })).filter(x => x.required > 0);
  const days = activeDays();
  const periodsFull = state.settings.periods.map(p => ({ id: p.id, label: p.label, start: p.start || '', end: p.end || '', isBreak: !!p.isBreak }));
  const openKeys = []; const snapshot = {};   // openKeys＝該班有課的格；snapshot＝已固定(非自編)的課供參考
  days.forEach(d => state.settings.periods.filter(p => !p.isBreak).forEach(p => {
    if (!(g && gradePeriodHasDay(g, p.id, d))) return;
    openKeys.push(d + '|' + p.id);
    const k = slotKey(classId, d, p.id); const sid = state.slots[k];
    if (sid && !isSelfCell(k)) snapshot[d + '|' + p.id] = { name: subjectName(sid), teacher: slotTeachersLabel(k), color: (subjectById(sid) || {}).color || '#94a3b8', textColor: subjTextColor(subjectById(sid)) };
  }));
  return {
    fmt: FILL_FMT, ver: 2,
    classId, className: c ? c.name : '', gradeId: c ? c.gradeId : '', homeroom: hr ? hr.name : '',
    homeroomEmail: hr ? (hr.email || '') : '',   // v09.08 綁定用：只有此 email 的 Google 帳號可開啟
    year: (state.settings || {}).reportYear || '', fileName: fillFileName(c),
    days, periodsFull, openKeys,
    cells: cells.map(k => { const a = k.split('|'); return { key: k, day: +a[1], period: a[2], label: DAY_LABELS[+a[1]] + periodLabel(a[2]) }; }),
    pool, snapshot,
    content: Object.fromEntries(cells.filter(k => state.slots[k]).map(k => [k, state.slots[k]])),   // 目前已填（排課者代填或先前）
    generatedAt: new Date().toISOString(),
  };
}
// 收回：把導師填課包合併回課表；回傳 {className, set, cleared, conflicts[], error?}
function mergeFillFile(obj) {
  if (!obj || obj.fmt !== FILL_FMT) return { error: '檔案格式不符（需 ' + FILL_FMT + '）' };
  const classId = obj.classId; const c = classById(classId);
  if (!c) return { error: '找不到對應班級：' + (obj.className || classId) };
  if (!state.lockFinalized) return { error: '課表未在鎖定狀態，無法收回填課（請先鎖定）' };
  const res = { className: obj.className || c.name, set: 0, cleared: 0, conflicts: [] };
  const content = obj.content || {};
  const poolIds = new Set(selfCoursePool(classId).map(s => s.id));
  const cells = new Set(classSelfCells(classId));
  const lbl = key => { const a = key.split('|'); return DAY_LABELS[+a[1]] + periodLabel(a[2]); };
  // 只「設定」content 列出的格（缺席不代表清空，避免舊填課包誤清協同連動格）
  Object.keys(content).forEach(key => {
    if (!cells.has(key) || selfCellTeacherLocked(key)) return;   // 非本班自編格／已完成鎖定→不動
    const chosen = content[key]; if (!chosen || state.slots[key] === chosen) return;
    if (!poolIds.has(chosen)) { res.conflicts.push(`${lbl(key)}：科目不在導師候選，略過`); return; }
    state.slots[key] = chosen; res.set++;
    // 分節上課(✂️)科目：自編格由本班級任導師任教，需記錄授課老師，否則顯示「未指定老師」
    const chSubj = subjectById(chosen), hrT = homeroomTeacher(classId);
    if (chSubj && chSubj.splitTeachers && hrT) state.slotTeachers[key] = hrT.id; else delete state.slotTeachers[key];
    const a = key.split('|'); const gid = c.coteach && c.coteach[chosen];   // 協同連動：夥伴班同格（自編、未鎖、空）一併填
    if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[chosen] === gid).forEach(p => {
      const mk = slotKey(p.id, a[1], a[2]);
      if (isSelfCell(mk) && !selfCellTeacherLocked(mk) && !state.slots[mk]) state.slots[mk] = chosen;
    });
  });
  // 只「清空」明確列在 cleared 的格（導師 UI 主動清除時填入）
  (obj.cleared || []).forEach(key => {
    if (!cells.has(key) || selfCellTeacherLocked(key)) return;
    if (state.slots[key]) { delete state.slots[key]; delete state.slotTeachers[key]; res.cleared++; }
  });
  // 超額提示（導師端已擋，收回再核一次）
  selfCoursePool(classId).forEach(s => { const req = selfCourseTarget(classId, s.id), pl = selfCoursePlaced(classId, s.id); if (pl > req) res.conflicts.push(`${s.name} 已排 ${pl} 節，超過應排 ${req} 節`); });
  const conf = computeConflicts();                          // 合併後衝堂提示
  cells.forEach(key => { if (state.slots[key] && conf[key]) res.conflicts.push(`${lbl(key)}：${conf[key].join('；')}`); });
  return res;
}

/* ---------- F③ 傳輸層：drive.file token + Drive REST + Picker ---------- */
let fillToken = null, fillTokenClient = null, _fillResolve = null, _fillReject = null, _pickerLoaded = false;
let teacherPacket = null, teacherFileId = null, teacherOrigKeys = null, teacherSavedJson = '';
function initFillTokenClient() {
  fillTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID, scope: FILL_SCOPE,
    callback: (resp) => {
      const ok = _fillResolve, fail = _fillReject; _fillResolve = _fillReject = null;
      if (resp && resp.access_token) { fillToken = { access_token: resp.access_token, expiresAt: Date.now() + ((Number(resp.expires_in) || 3600) * 1000) }; ok && ok(resp.access_token); }
      else fail && fail(new Error((resp && resp.error) || 'auth_failed'));
    },
    error_callback: (err) => { const fail = _fillReject; _fillResolve = _fillReject = null; fail && fail(new Error((err && err.type) || 'popup_closed')); },
  });
}
async function getFillToken(promptMode = '') {
  await ensureGis();
  if (fillToken && fillToken.expiresAt - 60000 > Date.now()) return fillToken.access_token;
  if (!fillTokenClient) initFillTokenClient();
  return new Promise((resolve, reject) => {
    let settled = false;   // v10.05 逾時保護（同 getAccessToken）
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); _fillResolve = _fillReject = null; fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 25000);
    _fillResolve = (v) => finish(resolve, v);
    _fillReject = (v) => finish(reject, v);
    try { fillTokenClient.requestAccessToken({ prompt: promptMode }); }
    catch (e) { finish(reject, e); }
  });
}
async function fillFetch(url, opts) {
  let token = await getFillToken('');
  // v10.10 一律 no-store：避免讀共享代課檔讀到瀏覽器快取的舊版，導致多次填報互相覆蓋。
  const build = (t) => ({ cache: 'no-store', ...opts, headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + t } });
  let res = await fetch(url, build(token));
  if (res.status === 401) { fillToken = null; token = await getFillToken(''); res = await fetch(url, build(token)); }
  return res;
}
async function driveCreateFolder(name) {
  const res = await fillFetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw new Error('建立資料夾失敗');
  return res.json();
}
async function drivePutJson(name, parentId, contentStr, fileId) {
  const boundary = 'csf' + Math.random().toString(16).slice(2);
  const metadata = fileId ? {} : (parentId ? { name, parents: [parentId] } : { name });   // parentId 為空＝建在雲端根目錄
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + contentStr + `\r\n--${boundary}--`;
  const base = 'https://www.googleapis.com/upload/drive/v3/files';
  const url = fileId ? `${base}/${fileId}?uploadType=multipart&fields=id,webViewLink` : `${base}?uploadType=multipart&fields=id,webViewLink`;
  const res = await fillFetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!res.ok) { let t = ''; try { t = await res.text(); } catch (e) {} throw new Error('寫入檔案失敗 (HTTP ' + res.status + ')：' + t.slice(0, 200)); }
  return res.json();
}
async function driveShare(fileId, email) {
  const res = await fillFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error('分享給 ' + email + ' 失敗：' + t.slice(0, 100)); }
  return res.json();
}
async function fillDownloadText(fileId) {
  const res = await fillFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { method: 'GET' });
  if (!res.ok) throw new Error('下載檔案失敗');
  return res.text();
}
async function fillUserInfo() {   // v10.01 取登入帳號 email + 顯示名稱
  try { const res = await fillFetch('https://www.googleapis.com/drive/v3/about?fields=user', { method: 'GET' }); if (!res.ok) return {}; const d = await res.json(); return { email: (d.user && d.user.emailAddress) || '', name: (d.user && d.user.displayName) || '' }; } catch (e) { return {}; }
}
async function fillUserEmail() {   // v09.08 取登入帳號 email（綁定驗證用）
  try { const res = await fillFetch('https://www.googleapis.com/drive/v3/about?fields=user', { method: 'GET' }); if (!res.ok) return ''; const d = await res.json(); return (d.user && d.user.emailAddress) || ''; } catch (e) { return ''; }
}
function loadPicker() {
  return new Promise((resolve, reject) => {
    if (_pickerLoaded && window.google && google.picker) return resolve();
    const done = () => gapi.load('picker', { callback: () => { _pickerLoaded = true; resolve(); } });
    if (window.gapi) return done();
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js'; s.async = true; s.defer = true;
    s.onload = done; s.onerror = () => reject(new Error('載入 Picker 失敗（網路）'));
    document.head.appendChild(s);
  });
}
async function pickFillFile(token) {
  await loadPicker();
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/json').setMode(google.picker.DocsViewMode.LIST);
    const picker = new google.picker.PickerBuilder()
      .setAppId(GOOGLE_PROJECT_NUMBER).setOAuthToken(token).setDeveloperKey(GOOGLE_API_KEY)
      .addView(view).setTitle('選擇你的班級填課檔（class-…）')
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs[0].id);
        else if (data.action === google.picker.Action.CANCEL) resolve(null);
      }).build();
    picker.setVisible(true);
  });
}

/* ---------- F③ 排課者：開放 / 收回 ---------- */
async function openFillShare(reopen) {
  const targets = state.classes.filter(c => classSelfCells(c.id).length > 0);
  if (!targets.length) { toast('沒有可填課的自編格（請先鎖定課表釋放自編格）'); return; }
  const missing = targets.filter(c => { const hr = homeroomTeacher(c.id); return !hr || !hr.email; });
  if (missing.length) { toast('這些班級導師未填 Email：' + missing.map(c => c.name).join('、') + '（到③教師補上）'); return; }
  const noCode = targets.filter(c => !c.code); // 檔名需要數字代號
  if (noCode.length) { toast('這些班級未填數字代號：' + noCode.map(c => c.name).join('、') + '（到②年級與班級補上，供檔名用）'); return; }
  try {
    toast('連線 Google…'); await getFillToken('');
    const year = String((state.settings || {}).reportYear || new Date().getFullYear());
    const folder = await driveCreateFolder(FILL_FOLDER_PREFIX + year);
    const files = {};
    for (const c of targets) {
      const name = fillFileName(c);
      const f = await drivePutJson(name, folder.id, JSON.stringify(buildFillFile(c.id)));
      const hr = homeroomTeacher(c.id);
      await driveShare(f.id, hr.email);
      files[c.id] = { fileId: f.id, link: f.webViewLink || '', email: hr.email, name };
    }
    state.fillShare = { folderId: folder.id, folderLink: folder.webViewLink || '', year, files, openedAt: new Date().toISOString() };
    fillProgress = null;                                     // v09.12 重新開放→清空舊進度快取
    save(); render(); toast('已開放線上填課，' + targets.length + ' 班已分享');
    fillManageModal();
  } catch (e) { toast('開放失敗：' + e.message); }
}
async function collectFill() {
  if (!state.fillShare || !state.fillShare.files) { toast('尚未開放線上填課'); return; }
  if (!state.lockFinalized) { toast('請先鎖定課表再收回'); return; }
  try {
    toast('讀取各班填課…'); await getFillToken('');
    const summaries = [];
    for (const classId of Object.keys(state.fillShare.files)) {
      const nm = (classById(classId) || {}).name || classId;
      let obj; try { obj = JSON.parse(await fillDownloadText(state.fillShare.files[classId].fileId)); }
      catch (e) { summaries.push({ error: nm + '：讀取/解析失敗' }); continue; }
      summaries.push(mergeFillFile(obj));
    }
    save(); render(); fillCollectResultModal(summaries);
  } catch (e) { toast('收回失敗：' + e.message); }
}
// v09.12 F③ 填課進度總覽：讀各班雲端填課檔，統計已填格數與是否已回傳（submittedAt）
async function refreshFillProgress() {
  const fs = state.fillShare; if (!fs || !fs.files) { toast('尚未開放線上填課'); return; }
  try {
    toast('讀取各班進度…'); await getFillToken('');
    const res = {};
    for (const cid of Object.keys(fs.files)) {
      const total = classSelfCells(cid).length;
      let filled = 0, submittedAt = '', ok = true;
      try {
        const obj = JSON.parse(await fillDownloadText(fs.files[cid].fileId));
        const cells = new Set(classSelfCells(cid));
        filled = Object.keys(obj.content || {}).filter(k => cells.has(k) && obj.content[k]).length;
        submittedAt = obj.submittedAt || '';
      } catch (e) { ok = false; }
      res[cid] = { total, filled, submitted: !!submittedAt, submittedAt, error: !ok };
    }
    fillProgress = res; fillManageModal();
    toast('進度已更新');
  } catch (e) { toast('讀取進度失敗：' + e.message); }
}
function fillProgressHTML() {
  const fs = state.fillShare; if (!fs || !fs.files) return '';
  const cids = Object.keys(fs.files);
  if (!fillProgress) {
    return `<div class="fill-prog"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <b>填課進度</b><button class="ghost" data-action="refresh-fillprogress">🔄 讀取進度</button></div>
      <p style="color:var(--muted);margin:6px 0 0">按「讀取進度」向雲端查各班填了多少、是否已回傳。</p></div>`;
  }
  let done = 0, pend = 0;
  const rows = cids.map(cid => {
    const nm = (classById(cid) || {}).name || cid; const p = fillProgress[cid] || {};
    let badge, cls;
    if (p.error) { badge = '讀取失敗'; cls = 'err'; pend++; }
    else if (p.submitted && p.filled >= p.total && p.total > 0) { badge = '✅ 已完成'; cls = 'done'; done++; }
    else if (p.submitted) { badge = '⚠ 已回傳但缺'; cls = 'part'; pend++; }
    else if (p.filled > 0) { badge = '✏️ 填寫中(未回傳)'; cls = 'part'; pend++; }
    else { badge = '⏳ 未交'; cls = 'todo'; pend++; }
    return `<tr><td><b>${esc(nm)}</b></td><td>${p.error ? '—' : p.filled + ' / ' + p.total + ' 格'}</td><td class="fp-${cls}">${badge}</td></tr>`;
  }).join('');
  return `<div class="fill-prog"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <b>填課進度</b>　<span style="color:var(--muted)">完成 <b style="color:var(--ok)">${done}</b> · 待催 <b style="color:var(--danger)">${pend}</b></span>
      <span style="margin-left:auto"></span>
      <button class="ghost" data-action="refresh-fillprogress">🔄 重新整理</button>
      <button class="ghost" data-action="copy-unsubmitted" ${pend ? '' : 'disabled'}>📋 複製未交名單</button>
    </div>
    <table class="data" style="margin-top:6px"><thead><tr><th>班級</th><th>已填</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function copyUnsubmittedList() {
  const fs = state.fillShare; if (!fs || !fs.files || !fillProgress) return;
  const lines = Object.keys(fs.files).filter(cid => {
    const p = fillProgress[cid] || {}; return p.error || !(p.submitted && p.filled >= p.total && p.total > 0);
  }).map(cid => {
    const nm = (classById(cid) || {}).name || cid; const email = fs.files[cid].email || '';
    const p = fillProgress[cid] || {}; const prog = p.error ? '讀取失敗' : `${p.filled}/${p.total}`;
    return `${nm}　${email}　(${prog})`;
  });
  if (!lines.length) { toast('沒有未交的班級'); return; }
  const text = '尚未完成線上填課的班級：\n' + lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('已複製 ' + lines.length + ' 筆未交名單'), () => toast('複製失敗，請手動選取'));
  else toast('此環境不支援自動複製');
}
function fillManageModal() {
  const fs = state.fillShare;
  const targets = state.classes.filter(c => classSelfCells(c.id).length > 0);
  const fillUrl = location.origin + location.pathname + '?fill=1';
  const rowsOpen = fs && fs.files ? Object.keys(fs.files).map(cid => {
    const f = fs.files[cid]; const nm = (classById(cid) || {}).name || cid;
    return `<tr><td>${esc(nm)}</td><td>${esc(f.email)}</td><td><code>${esc(f.name || '')}</code></td></tr>`;
  }).join('') : '';
  const body = fs && fs.files
    ? `<div class="total-badge ok">已開放（${esc(fs.year)}）· ${Object.keys(fs.files).length} 班已分享</div>
       <p style="margin:8px 0"><b>把這個填課連結寄給各班導師：</b><br><code style="user-select:all;word-break:break-all">${esc(fillUrl)}</code></p>
       <p style="color:var(--muted);margin:8px 0">導師開連結 → 用學校 Google 帳號登入 → Picker 選<b>自己班的檔案</b>（依下表檔名辨識）→ 填課存回。檔案也已直接分享到導師 Email。</p>
       ${fillProgressHTML()}
       <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted)">分享明細（班級 / 導師 Email / 檔名）</summary>
         <table class="data"><thead><tr><th>班級</th><th>導師 Email</th><th>檔名（Picker 中辨識）</th></tr></thead><tbody>${rowsOpen}</tbody></table>
       </details>
       <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
         <button class="btn" data-action="collect-fill">📥 收回填課（合併進課表）</button>
         <button class="ghost" data-action="reopen-fill">♻️ 重新開放（重建檔案）</button>
       </div>`
    : `<p style="margin-top:0">將為每個有自編格的班級建立一份雲端「填課檔」，分享給該班導師的 Email；導師線上填完，你再「收回填課」合併回課表。</p>
       <p style="color:var(--muted)">需求：課表已鎖定、各班導師已在「③ 教師」填 <b>Google Email</b>、各班已在「② 年級與班級」填 <b>數字代號</b>（供檔名用）。將分享的班級：<b>${esc(targets.map(c => c.name).join('、') || '（無）')}</b></p>
       <button class="btn" data-action="open-fill">☁️ 開放線上填課</button>`;
  openModal({ title: '導師線上填課（分享）', wide: true, body });
}
function fillCollectResultModal(summaries) {
  const rows = summaries.map(s => s.error
    ? `<tr><td colspan="2" style="color:var(--danger)">${esc(s.error)}</td></tr>`
    : `<tr><td><b>${esc(s.className)}</b></td><td>填入 ${s.set}、清空 ${s.cleared}${s.conflicts && s.conflicts.length ? `<div style="color:var(--danger);font-size:12px;margin-top:2px">⚠ ${s.conflicts.map(esc).join('；')}</div>` : ''}</td></tr>`
  ).join('');
  openModal({ title: '收回填課結果', wide: true, body: `<p style="margin-top:0">已把各班導師的選課合併進課表：</p><table class="data"><thead><tr><th>班級</th><th>結果</th></tr></thead><tbody>${rows}</tbody></table>` });
}

/* ---------- F③ 導師端：登入 → Picker → 填課 → 存回 ---------- */
async function teacherFillStart() {
  try {
    if (!kioskFill) setKiosk(true);
    toast('登入 Google…'); const token = await getFillToken('');
    const myEmail = (await fillUserEmail()).trim().toLowerCase();
    const fileId = await pickFillFile(token);
    if (!fileId) return;
    const obj = JSON.parse(await fillDownloadText(fileId));
    if (obj.fmt !== FILL_FMT) { toast('這不是填課檔（course-fill）'); return; }
    const owner = (obj.homeroomEmail || '').trim().toLowerCase();   // v09.08 嚴格綁定：只有對應導師帳號可開啟
    if (owner) {
      if (!myEmail) { toast('無法確認你的 Google 帳號，請重試'); return; }
      if (owner !== myEmail) { toast(`此檔為「${obj.className || ''}」導師（${obj.homeroomEmail}）專用，與你的帳號（${myEmail}）不符，無法開啟。`); return; }
    }
    teacherPacket = obj; teacherFileId = fileId; teacherPacket.content = teacherPacket.content || {};
    teacherOrigKeys = new Set(Object.keys(teacherPacket.content));
    teacherSavedJson = JSON.stringify(teacherPacket.content); fillEnded = false;
    render();
  } catch (e) { toast('開啟失敗：' + e.message); }
}
const tfillPlaced = sid => Object.values((teacherPacket || {}).content || {}).filter(v => v === sid).length;
// 導師填課主畫面（kiosk）：整張課表，🧩 自編格可點選課、🔒 為已固定課、參考上下節
function viewTeacherFill() {
  if (fillEnded) return `<div class="card"><div class="card-body" style="text-align:center;padding:48px 20px">
      <h2 style="margin-top:0">✅ 填課已結束</h2>
      <p style="color:var(--muted)">你的選課已處理完畢，<b>可以直接關閉此分頁</b>。</p>
      <button class="btn" data-action="teacher-relogin">重新開啟填課</button></div></div>`;
  const p = teacherPacket;
  if (!p) return `<div class="page-head"><h2>🧑‍🏫 導師線上填課</h2></div>
    <div class="card"><div class="card-body">
      <p>用學校 Google 帳號登入，開啟排課老師分享給你的「班級填課檔」，為 🧩 自編格（空白待選的格）選課。</p>
      <button class="btn" data-action="teacher-fill">用 Google 登入並選擇班級檔</button></div></div>`;
  const smap = {}; p.pool.forEach(s => smap[s.sid] = s);
  const openSet = new Set(p.openKeys || []); const cellSet = new Set((p.cells || []).map(c => c.key));
  const pills = p.pool.map(s => { const pl = tfillPlaced(s.sid); const over = pl > s.required; return `<span class="pill" style="background:${s.color};color:#fff;opacity:${pl ? 1 : .55}">${esc(s.name)} ${pl}/${s.required}${over ? '⚠' : ''}</span>`; }).join(' ') || '<span style="color:var(--muted)">（無可選科目）</span>';
  const remaining = (p.cells || []).filter(c => !p.content[c.key]).length;
  let table = `<table class="timetable"><thead><tr><th class="period-th">節次</th>${p.days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const pr of p.periodsFull) {
    if (pr.isBreak) { table += `<tr class="break-row"><td colspan="${p.days.length + 1}">${esc(pr.label)}${pr.start ? '　' + esc(pr.start) + '–' + esc(pr.end) : ''}</td></tr>`; continue; }
    table += `<tr><td class="period-th">${esc(pr.label)}<small>${esc(pr.start)}${pr.end ? '–' + esc(pr.end) : ''}</small></td>`;
    for (const d of p.days) {
      const key = d + '|' + pr.id; const cellKey = p.classId + '|' + d + '|' + pr.id;
      if (!openSet.has(key)) { table += `<td class="cell blocked" title="此節不上課"></td>`; continue; }
      if (cellSet.has(cellKey)) {
        const sid = p.content[cellKey]; const s = sid ? smap[sid] : null; const color = s ? s.color : '#dfeee7';   // 空自編格改用淺色凹槽底，讓「深挖」看得出來（已填則用科目色）
        table += `<td class="cell placeable" data-action="tfill-cell" data-key="${esc(cellKey)}" title="自編格：點我選課">
          <div class="cell-lesson self-designed ${s ? '' : 'released'}" style="background:${color};color:${subjTextColor(s, color)}">🧩${s ? esc(s.name) : '點我選課'}</div></td>`;
      } else {
        const snap = p.snapshot[key];
        table += snap
          ? `<td class="cell" title="已固定，不可改"><div class="cell-lesson locked" style="background:${snap.color || '#94a3b8'};color:${snap.textColor || textOn(snap.color || '#94a3b8')};opacity:.9"><span class="lock-mark">🔒</span>${esc(snap.name)}<small>${esc(snap.teacher || '')}</small></div></td>`
          : `<td class="cell"></td>`;
      }
    }
    table += `</tr>`;
  }
  table += `</tbody></table>`;
  return `<div class="page-head no-print"><h2>🧑‍🏫 ${esc(p.className)} 導師填課</h2><div class="hint">點 <b>🧩</b> 自編格選課；<b>🔒</b> 為已固定的課（不可改）。填完按「儲存到雲端」，再通知排課老師收回。</div></div>
    <div class="lock-banner no-print"><span>導師：${esc(p.homeroom || '')}｜檔案：${esc(p.fileName || '')}｜剩 <b>${remaining}</b> 格待選</span>
      <button class="btn" data-action="tfill-save">💾 儲存到雲端</button>
      <button class="ghost" data-action="tfill-exit">完成／關閉</button></div>
    <div class="card"><div class="card-body"><div style="margin-bottom:10px">${pills}</div><div class="grid-wrap">${table}</div></div></div>`;
}
function teacherPickModal(key) {
  const p = teacherPacket; const cur = p.content[key] || '';
  const chips = p.pool.map(s => {
    const pl = tfillPlaced(s.sid); const full = pl >= s.required && cur !== s.sid; const isCur = cur === s.sid;
    return `<button class="suggest-row ${isCur ? 'selected' : ''}" data-action="tfill-pick" data-key="${esc(key)}" data-sid="${s.sid}" ${full ? 'disabled' : ''}>
      <span class="sug-dot" style="background:${s.color}"></span>
      <span><b>${esc(s.name)}</b> <span style="color:${full ? 'var(--ok)' : 'var(--muted)'}">${pl}/${s.required}${full ? '（已滿）' : ''}</span></span></button>`;
  }).join('');
  const a = key.split('|'); const plabel = (p.periodsFull.find(x => x.id === a[2]) || {}).label || a[2];
  openModal({
    title: `選課 · ${esc(p.className)} ${DAY_LABELS[+a[1]]}${esc(plabel)}`,
    body: (p.pool.length ? `<div class="suggest-list">${chips}</div>` : `<p style="color:var(--muted)">目前沒有可選科目（可能都已排滿）。</p>`)
      + (cur ? `<div style="margin-top:10px"><button class="ghost" data-action="tfill-clear" data-key="${esc(key)}">清空此格</button></div>` : ''),
  });
}
async function teacherSaveFill() {
  try {
    const p = teacherPacket; if (!p) return;
    const cleared = [...teacherOrigKeys].filter(k => !p.content[k]);   // 只把「原本有、現在清掉」記為明確清空
    const out = { ...p, content: p.content, cleared, submittedAt: new Date().toISOString() };
    toast('儲存中…');
    await drivePutJson('', null, JSON.stringify(out), teacherFileId);
    teacherOrigKeys = new Set(Object.keys(p.content));
    teacherSavedJson = JSON.stringify(p.content);
    toast('已儲存到雲端，請通知排課老師「收回填課」');
  } catch (e) { toast('儲存失敗：' + e.message); }
}

function setKioskNav(on) {   // 只負責隱藏/顯示導覽與右上動作鈕
  const tabs = document.getElementById('tabs'); if (tabs) tabs.style.display = on ? 'none' : '';
  document.querySelectorAll('.topbar-actions').forEach(e => e.style.display = on ? 'none' : '');
}
function setKiosk(on) { kioskFill = on; setKioskNav(on); render(); }              // v09.05 導師填課 kiosk
function setSubstKiosk(on) { substKiosk = on; setKioskNav(on); render(); }        // v10.01 代課填報 kiosk
function render() {
  if (substKiosk) { $('#view').innerHTML = viewSubstKiosk(); return; }   // 代課填報模式
  if (kioskFill) { $('#view').innerHTML = viewTeacherFill(); return; }   // 導師填課模式：只出填課介面
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  const view = $('#view');
  switch (currentTab) {
    case 'home': view.innerHTML = viewHome(); break;
    case 'subjects': view.innerHTML = viewSubjects(); break;
    case 'grades': case 'classes': view.innerHTML = viewGradesClasses(); break;
    case 'teachers': view.innerHTML = viewTeachers(); break;
    case 'domains': view.innerHTML = viewDomains(); break;
    case 'schedule': view.innerHTML = viewSchedule(); break;
    case 'output': view.innerHTML = viewOutput(); break;
    case 'subst': view.innerHTML = viewSubst(); break;
    case 'settings': view.innerHTML = viewSettings(); break;
  }
}

// 子頁頂端導覽（v10.19）：品牌區已移除，導覽改放各子頁頂端。
// 回首頁按鈕（kiosk 模式不提供，教師不得進入系統）。
const NAV_SECTIONS = [
  { tab: 'subjects', label: '科目' },
  { tab: 'grades', label: '年級與班級' },
  { tab: 'teachers', label: '教師配課' },
  { tab: 'schedule', label: '排課' },
];
const homeBtn = () => (kioskFill || substKiosk) ? '' : `<button class="pn-home" data-action="goto" data-goto="home">← 回首頁</button>`;
// 4 個核心頁：頂端導覽列「取代」子頁標題（當前頁以 active pill 標示），右側可帶頁面動作鈕
function coreHead(current, actions = '') {
  const links = NAV_SECTIONS.map(s =>
    `<button class="pn-link${s.tab === current ? ' active' : ''}" data-action="goto" data-goto="${s.tab}"${s.tab === current ? ' aria-current="page"' : ''}>${s.label}</button>`
  ).join('');
  const home = homeBtn();
  return `<div class="page-nav core">${home}${home ? '<span class="pn-sep"></span>' : ''}${links}${actions ? `<div class="pn-actions">${actions}</div>` : ''}</div>`;
}
// 其餘子頁：保留標題，「回首頁」放在標題同一列
function subHead(title, actions = '', cls = '') {
  return `<div class="page-head ${cls}"><div class="ph-left">${homeBtn()}<h2>${title}</h2></div>${actions ? `<div class="ph-actions">${actions}</div>` : ''}</div>`;
}

/* ==========================================================================
   🏠 首頁儀表板（v10.19）— 各步驟完成度、待辦、快速入口
   純彙整既有訊號，不動資料。
   ========================================================================== */
function homeStats() {
  const subjectsDone = !!state.domainsConfirmed && state.subjects.length > 0;
  const classesDone = state.classes.length > 0;
  const staffProblems = checkStaffing();
  const noHr = unsetHomerooms();
  const staffDone = staffingConfirmed();

  let required = 0;
  state.classes.forEach(c => { required += classWeeklyHours(c); });
  const placed = Object.keys(state.slots).length;
  const locked = !!state.lockFinalized;
  const schedPct = required > 0 ? Math.min(100, Math.round(placed / required * 100)) : 0;

  const cloudOn = !!cloudState.enabled;
  const lastSync = cloudState.lastSyncedAt || '';
  let backupDays = null;
  if (lastSync) { const t = new Date(lastSync).getTime(); if (!isNaN(t)) backupDays = Math.floor((Date.now() - t) / 86400000); }
  const backupFailed = !!cloudState.backupFailed;

  return { subjectsDone, classesDone, staffProblems, noHr, staffDone, required, placed, locked, schedPct, cloudOn, lastSync, backupDays, backupFailed };
}

function viewHome() {
  const st = homeStats();
  const s = state.settings || {};
  const brandNew = state.subjects.length === 0 && state.classes.length === 0;

  // 抬頭識別條
  const header = `<div class="home-hero card">
    <div class="card-body">
      <div class="hh-info">
        <div class="hh-school">${esc(s.reportSchool || '- - - - - - - - - - - -')}</div>
        <div class="hh-sub">${esc(s.reportYear || '- - -')} 學年度　·　課務編排 ${APP_VERSION}</div>
      </div>
      <button class="hh-backup" data-action="backup" title="匯出 / 匯入備份">💾 備份</button>
    </div></div>`;

  // 全新使用者：引導從①開始
  if (brandNew) {
    return `${header}
      <div class="card"><div class="card-body" style="text-align:center;padding:36px 16px">
        <div style="font-size:44px;line-height:1">📘</div>
        <h3 style="margin:12px 0 6px">歡迎使用課務編排</h3>
        <p style="color:var(--muted);max-width:520px;margin:0 auto 18px">依序完成 <b>①科目 → ②年級與班級 → ③教師配課 → ④排課</b>，即可輸出全校課表。先從設定科目開始吧。</p>
        <button class="btn" data-action="goto" data-goto="subjects">① 開始設定科目 →</button>
      </div></div>`;
  }

  // 步驟完成度
  const stepCard = (num, name, done, tab, note) => `
    <button class="home-step ${done ? 'done' : 'todo'}" data-action="goto" data-goto="${tab}">
      <div class="hs-badge">${done ? '✓' : '⚠'}</div>
      <div class="hs-body"><div class="hs-name">${num} ${name}</div>
        <div class="hs-note">${note}</div></div>
    </button>`;
  const step1 = stepCard('①', '科目', st.subjectsDone, 'subjects', st.subjectsDone ? `${state.subjects.length} 科` : '尚未完成領域／科目');
  const step2 = stepCard('②', '年級與班級', st.classesDone, 'grades', st.classesDone ? `${state.classes.length} 班` : '尚未建立班級');
  const staffNote = st.staffDone ? '配課完成 ✓'
    : (st.staffProblems.length || st.noHr.length)
      ? `${st.staffProblems.length ? `${st.staffProblems.length} 處配課待處理` : ''}${st.staffProblems.length && st.noHr.length ? '、' : ''}${st.noHr.length ? `${st.noHr.length} 班缺導師` : ''}`
      : '尚未按「檢查全校配課」';
  const step3 = stepCard('③', '教師配課', st.staffDone, 'teachers', staffNote);
  const step4 = stepCard('④', '排課', st.locked, 'schedule', st.locked ? '已鎖定 ✓' : (st.required ? `已排 ${st.placed}/${st.required} 節` : '尚未可排課'));
  const steps = `<div class="home-steps">${step1}${step2}${step3}${step4}</div>`;

  // 排課完成度進度條
  const progress = st.required ? `<div class="card"><div class="card-body">
      <div class="hp-row"><span>排課完成度</span><b>${st.placed} / ${st.required} 節（${st.schedPct}%）</b></div>
      <div class="hp-bar"><div class="hp-fill" style="width:${st.schedPct}%"></div></div>
    </div></div>` : '';

  // 待辦清單
  const todos = [];
  if (st.staffProblems.length) todos.push({ t: `配課有 ${st.staffProblems.length} 處待處理（缺漏／超額／未指派）`, tab: 'teachers' });
  if (st.noHr.length) todos.push({ t: `${st.noHr.length} 個班級尚未指定級任導師（${st.noHr.slice(0, 3).map(esc).join('、')}${st.noHr.length > 3 ? '…' : ''}）`, tab: 'teachers' });
  if (st.required && st.placed < st.required) todos.push({ t: `課表尚有 ${st.required - st.placed} 節未排`, tab: 'schedule' });
  if (st.placed > 0 && !st.locked) todos.push({ t: '課表尚未鎖定（鎖定後才能開放導師線上填課）', tab: 'schedule' });
  // 久未備份提醒
  if (!st.cloudOn) todos.push({ t: '尚未連結雲端備份，換裝置有遺失風險', tab: 'settings' });
  else if (st.backupFailed) todos.push({ t: '有變更尚未備份成功，請到設定按「立即備份」', tab: 'settings' });
  else if (st.backupDays === null) todos.push({ t: '已連結雲端但尚未備份過', tab: 'settings' });
  else if (st.backupDays >= 7) todos.push({ t: `已 ${st.backupDays} 天未備份，建議立即備份`, tab: 'settings' });

  const todoCard = `<div class="card"><div class="card-body">
    <h3 style="margin:0 0 10px">📋 待辦</h3>
    ${todos.length
      ? `<div class="home-todos">${todos.map(x => `<button class="home-todo" data-action="goto" data-goto="${x.tab}"><span class="ht-dot">●</span><span>${x.t}</span><span class="ht-arrow">→</span></button>`).join('')}</div>`
      : '<p style="color:var(--ok);margin:0">✓ 一切就緒，沒有待辦事項。</p>'}
  </div></div>`;

  // 快速入口
  const quick = `<div class="card"><div class="card-body">
    <h3 style="margin:0 0 10px">⚡ 快速入口</h3>
    <div class="home-quick">
      <button class="btn" data-action="goto" data-goto="output">🖨 課表輸出</button>
      <button class="btn ghost" data-action="goto" data-goto="subst">🔁 代課 / 線上填報</button>
      <button class="btn ghost" data-action="goto" data-goto="settings">⚙️ 設定</button>
      <button class="btn ghost" data-action="help">❓ 使用說明</button>
    </div>
  </div></div>`;

  return `${header}${steps}${progress}${todoCard}${quick}`;
}

/* ==========================================================================
   ① 科目
   ========================================================================== */
function viewSubjects() {
  const confirmed = !!state.domainsConfirmed;
  const head = coreHead('subjects', confirmed ? '<button class="btn" data-action="add-subject">＋ 新增科目</button>' : '');
  return head + subjDomainFold(confirmed) + subjBody(confirmed);
}
// ① 科目：領域節數摺疊區（需先完成才能新增科目）
function subjDomainFold(confirmed) {
  const open = (!confirmed || subjDomainOpen) ? 'open' : '';
  const badge = confirmed ? '<span class="pill green">✓ 已完成</span>' : '<span class="pill amber">請先設定</span>';
  const confirmBtn = confirmed
    ? ''
    : '<button class="btn" data-action="confirm-domains" style="margin-top:14px">✓ 完成領域設定，開始建立科目</button>';
  return `<details class="domain-fold" ${open}>
    <summary>📚 領域節數設定 ${badge}</summary>
    <div class="domain-fold-body">
      <div class="hint" style="margin-bottom:12px;color:var(--muted)">各領域每年級的<b>建議節數</b>（可編輯）與<b>目前實配</b>對照。<b style="color:var(--warn)">預設數字為 108 課綱起點，請務必依課綱／貴校實況校對。</b>科目會逐科指定「所屬領域」，故請先完成此表。</div>
      <button class="btn" data-action="add-domain">＋ 新增領域</button>
      <div style="margin-top:12px">${domainRefAndCmp()}</div>
      ${confirmBtn}
    </div>
  </details>`;
}
// ① 科目：科目本體（未完成領域→閘門提示；完成→卡片）
function subjBody(confirmed) {
  if (!confirmed)
    return `<div class="card"><div class="card-body" style="text-align:center;color:var(--muted);padding:32px 16px">
      請先於上方完成「領域節數」設定，按 <b>✓ 完成領域設定</b> 後即可開始新增科目。</div></div>`;
  const hint = `<div class="hint" style="margin-bottom:12px;color:var(--muted)">教學型態：<b>單一教師</b>整科一位老師；<b>👥 分組教學</b>同班多師「同一節」平行上；<b>✂️ 分節上課</b>多師分攤節數、各上「不同節」（如生活 6 節＝A 上 4＋B 上 2）。點卡片可編輯，刪除鈕在卡片右下角。</div>`;
  if (state.subjects.length === 0) return hint + emptyCard('尚無科目', '點右上「＋ 新增科目」建立，例如：國語、數學、英語、自然、體育、藝術…');
  const modePill = s => s.splitTeachers ? '<span class="pill teal">✂️ 分節上課</span>' : s.allowGrouping ? '<span class="pill amber">👥 分組教學</span>' : '<span class="pill gray">單一教師</span>';
  const lockPill = s => {
    const parts = [];
    if ((s.lockDays || []).length) parts.push(s.lockDays.slice().sort((a, b) => a - b).map(d => DAY_LABELS[d]).join('/'));
    if ((s.lockPeriods || []).length) parts.push(s.lockPeriods.map(pid => (byId(state.settings.periods, pid) || {}).label || pid).join('/'));
    return parts.length ? `<span class="pill gray">🔒 ${esc(parts.join('｜'))}</span>` : '';
  };
  const domainPill = s => (!s.domainId || !domainById(s.domainId))
    ? '<span class="pill amber">未分類</span>'
    : `<span class="pill gray">${esc(domainName(s.domainId))}</span>`;
  const cards = state.subjects.map(s => {
    const consec = s.consecutive ? `<span class="pill blue">⏱ 連堂${s.consecutivePairs != null ? '×' + s.consecutivePairs : ''}</span>` : '';
    const lock = lockPill(s);
    const row2 = (consec || lock) ? `<div class="sc-row">${consec}${lock}</div>` : '';
    return `<div class="subj-card" data-action="edit-subject" data-id="${s.id}">
      <div class="sc-head"><span class="sc-name" style="background:${s.color};color:${subjTextColor(s)}">${esc(s.name)}</span></div>
      <div class="sc-meta">
        <div class="sc-row">${domainPill(s)}${modePill(s)}</div>
        ${row2}
      </div>
      <button class="icon-btn sc-del" data-action="del-subject" data-id="${s.id}" title="刪除科目">🗑️</button>
    </div>`;
  }).join('');
  return hint + `<div class="subj-cards">${cards}</div>`;
}
function subjectModal(existing) {
  const s = existing || { name: '', color: COLORS[state.subjects.length % COLORS.length], textColor: '', domainId: '', allowGrouping: false, splitTeachers: false, consecutive: false, lockDays: [], lockPeriods: [] };
  const curText = s.textColor || textOn(s.color);   // 目前文字色（未設過→依底色自動）
  const mode = s.splitTeachers ? 'split' : s.allowGrouping ? 'group' : 'single';
  const domainOpts = `<option value="">（未分類）</option>` +
    state.domains.map(d => `<option value="${d.id}" ${s.domainId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const lockDays = new Set(s.lockDays || []);
  const lockPeriods = new Set(s.lockPeriods || []);
  // 偏好節次：優先用 preferPeriods；舊資料只有偏好時段(preferBand)時，換算成對應的上午/下午各節（整併「偏好時段」與「偏好節次」為單一控制）
  const prefSet = (s.preferPeriods && s.preferPeriods.length) ? new Set(s.preferPeriods)
    : s.preferBand === 'am' ? new Set(lessonPeriods().filter(p => isMorningPeriod(p.id)).map(p => p.id))
    : s.preferBand === 'pm' ? new Set(lessonPeriods().filter(p => !isMorningPeriod(p.id)).map(p => p.id))
    : new Set();
  const spread = s.gapDays ? 'gap' : s.distinctDays ? 'distinct' : 'none';   // 整併「每天最多1節」+「隔天以上」為單一下拉
  const dayChecks = activeDays().map(d => `<label class="checkbox chk-inline"><input type="checkbox" class="s-lockday" value="${d}" ${lockDays.has(d) ? 'checked' : ''}> ${DAY_LABELS[d]}</label>`).join('');
  const perChecks = lessonPeriods().map(p => `<label class="checkbox chk-inline"><input type="checkbox" class="s-lockper" value="${p.id}" ${lockPeriods.has(p.id) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('');
  const prefPerChecks = lessonPeriods().map(p => `<label class="checkbox chk-inline"><input type="checkbox" class="s-prefper" value="${p.id}" ${prefSet.has(p.id) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('');
  openModal({
    title: existing ? '編輯科目' : '新增科目',
    body: `
      <label class="field"><span>科目名稱</span><input type="text" id="sName" value="${esc(s.name)}" oninput="var p=document.getElementById('sPreview');if(p)p.textContent=this.value||'科目'"></label>
      <div class="field-row" style="align-items:flex-end">
        <label class="field" style="flex:1;margin-bottom:0"><span>底色</span><input type="color" id="sColor" value="${s.color}" style="height:40px;padding:2px" oninput="var p=document.getElementById('sPreview');if(p)p.style.background=this.value"></label>
        <label class="field" style="flex:1;margin-bottom:0"><span>文字色</span><input type="color" id="sTextColor" value="${curText}" style="height:40px;padding:2px" oninput="var p=document.getElementById('sPreview');if(p)p.style.color=this.value"></label>
        <div class="field" style="flex:1.4;margin-bottom:0"><span>預覽</span><span id="sPreview" class="pill" style="display:flex;align-items:center;justify-content:center;height:40px;font-weight:800;font-size:15px;background:${s.color};color:${curText}">${esc(s.name) || '科目'}</span></div>
      </div>
      <p class="hint" style="color:var(--muted);margin:-4px 0 8px;font-size:12px">底色＋文字色可自由搭配，方便一眼分辨 19 科；文字色預設依底色自動取黑/白，可自行調整。</p>
      <div class="field-row">
        <label class="field" style="flex:1"><span>所屬領域</span><select id="sDomain">${domainOpts}</select></label>
        <label class="field" style="flex:2"><span>教學型態</span>
          <select id="sMode">
            <option value="single" ${mode === 'single' ? 'selected' : ''}>單一教師（整科由一位老師上）</option>
            <option value="group" ${mode === 'group' ? 'selected' : ''}>👥 分組教學（多師「同一節」平行上，不計衝堂）</option>
            <option value="split" ${mode === 'split' ? 'selected' : ''}>✂️ 分節上課（多師分攤、各上「不同節」，如生活 A上4＋B上2）</option>
          </select></label>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin:6px 0 2px;flex-wrap:wrap">
        <label class="checkbox" style="margin:0"><input type="checkbox" id="sConsec" ${s.consecutive ? 'checked' : ''}> ⏱ 需連堂（兩節相鄰接續上）</label>
        <label class="field" style="margin:0;flex-direction:row;align-items:center;gap:6px"><span style="white-space:nowrap">連堂次數（對）</span><input type="number" id="sConsecPairs" min="0" max="10" value="${s.consecutivePairs != null ? s.consecutivePairs : ''}" placeholder="自動" style="width:70px"></label>
        <span class="hint" style="color:var(--muted);font-size:12px">留空＝盡量成對；如自然 3 節填 <b>1</b>＝1 連堂＋1 節單獨</span>
      </div>

      <details class="subj-adv"><summary>🔒 排課限制（硬性：勾了就<b>只</b>排在這裡；不勾＝不限，手動不受限）</summary>
        <div class="lock-group"><div class="lock-label">只排在這些<b>上課日</b>：</div><div class="chk-row">${dayChecks || '<span style="color:var(--muted)">尚無上課日</span>'}</div></div>
        <div class="lock-group"><div class="lock-label">只排在這些<b>節次</b>：</div><div class="chk-row">${perChecks}</div></div>
        <div class="hint" style="color:var(--muted);font-size:12px">例：母語只勾「週四」；彈性在地勾「週五」＋「第1節」；體育只勾「第2/3/6/7節」。</div>
      </details>

      <details class="subj-adv"><summary>🪄 自動排課偏好（軟性：只影響「自動排課」的取捨，手動排課不受限）</summary>
        <div class="lock-group"><div class="lock-label">偏好<b>節次</b>（盡量排在勾選的節，如國語偏好第1節）
          <span class="pref-quick"><button type="button" class="ghost xs" data-action="pref-am">上午</button><button type="button" class="ghost xs" data-action="pref-pm">下午</button><button type="button" class="ghost xs" data-action="pref-clear">清除</button></span></div>
          <div class="chk-row">${prefPerChecks}</div></div>
        <label class="field" style="max-width:300px;margin-top:8px"><span>多節分散（同科多節如何散開）</span>
          <select id="sSpread">
            <option value="none" ${spread === 'none' ? 'selected' : ''}>不限</option>
            <option value="distinct" ${spread === 'distinct' ? 'selected' : ''}>每天最多 1 節（分散不同天）</option>
            <option value="gap" ${spread === 'gap' ? 'selected' : ''}>隔天以上（兩節不排相鄰兩天，如體育）</option>
          </select></label>
        <label class="checkbox" style="margin-top:10px"><input type="checkbox" id="sAvoidLast" ${s.avoidLastPeriod ? 'checked' : ''}> 主科：盡量<b>不排在每天最後一節</b>（末節優先給輕科）</label>
        <label class="checkbox" style="margin-top:6px"><input type="checkbox" id="sSingleApart" ${s.singleApartFromPair ? 'checked' : ''}> 連堂剩餘的<b>單堂不與連堂對相鄰天</b>（如社會/自然 2連堂+1獨立；連堂在週二→單堂避開週一~週三）</label>
        <label class="checkbox" style="margin-top:6px"><input type="checkbox" id="sExCap" ${s.excludeDailyCap ? 'checked' : ''}> 不列入教師單日節數上限（如母語課）</label>
        <div class="hint" style="color:var(--muted);font-size:12px">「多節分散」與「需連堂」互斥（連堂本就同日兩節），設連堂時自動忽略。</div>
      </details>`,
    onSave: () => {
      const name = $('#sName').value.trim();
      if (!name) { toast('請輸入科目名稱'); return false; }
      const m = $('#sMode').value;
      const ld = Array.from(document.querySelectorAll('.s-lockday:checked')).map(el => parseInt(el.value, 10));
      const lp = Array.from(document.querySelectorAll('.s-lockper:checked')).map(el => el.value);
      const pp = Array.from(document.querySelectorAll('.s-prefper:checked')).map(el => el.value);
      const consec = $('#sConsec').checked;
      const pairsRaw = ($('#sConsecPairs').value || '').trim();
      const consecutivePairs = consec && pairsRaw !== '' ? Math.max(0, parseInt(pairsRaw, 10) || 0) : null;
      const spreadV = $('#sSpread').value;   // none / distinct / gap（整併原兩個 checkbox）
      const data = { name, color: $('#sColor').value, textColor: $('#sTextColor').value, domainId: $('#sDomain').value, allowGrouping: m === 'group', splitTeachers: m === 'split', consecutive: consec, consecutivePairs, lockDays: ld, lockPeriods: lp, distinctDays: spreadV === 'distinct', gapDays: spreadV === 'gap', preferBand: 'any', preferPeriods: pp, avoidLastPeriod: $('#sAvoidLast').checked, singleApartFromPair: $('#sSingleApart').checked, excludeDailyCap: $('#sExCap').checked };
      if (existing) Object.assign(existing, data); else state.subjects.push({ id: uid(), ...data });
      save(); render(); toast('已儲存科目');
      return true;
    },
  });
}
function delSubject(id) {
  const s = subjectById(id); if (!s) return;
  const usedByGrade = state.grades.some(g => g.subjectHours.some(x => x.subjectId === id));
  if (usedByGrade) { toast(`「${s.name}」已被年級節數使用，請先於「年級」取消該科再刪除。`); return; }
  confirmDelete(`刪除科目「${s.name}」？`, () => { state.subjects = state.subjects.filter(x => x.id !== id); });
}

/* ==========================================================================
   ② 年級（節次表 + 科目節數）
   ========================================================================== */
// ② 年級與班級（年級設定摺疊 + 班級卡片）
function viewGradesClasses() {
  if (state.subjects.length === 0)
    return coreHead('grades') + emptyCard('請先設定科目', '需先到「① 科目」建立科目，年級才能勾選開課科目並配節數。');
  return coreHead('grades') + gradeFold() + classCards();
}
// 年級設定（節次表＋科目節數）— 可摺疊
function gradeFold() {
  if (!selectedGradeId || !gradeById(selectedGradeId)) selectedGradeId = state.grades[0].id;
  const g = gradeById(selectedGradeId);
  const nav = state.grades.map(x => `<button class="gtab ${x.id === selectedGradeId ? 'active' : ''}" data-action="sel-grade" data-id="${x.id}">
    ${esc(x.name)} ${gradeComplete(x) ? '<span class="ok-check">✓</span>' : ''}</button>`).join('');

  const days = activeDays();
  // 節次表 grid
  let grid = `<table class="avail"><thead><tr><th>節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of lessonPeriods()) {
    grid += `<tr><th>${esc(p.label)}<br><small style="color:var(--muted);font-weight:400">${esc(p.start)}–${esc(p.end)}</small></th>`;
    for (const d of days) {
      const on = gradePeriodHasDay(g, p.id, d);
      grid += `<td class="slot ${on ? 'on' : ''}" data-action="toggle-gradeday" data-gid="${g.id}" data-pid="${p.id}" data-day="${d}">${on ? '✓' : ''}</td>`;
    }
    grid += `</tr>`;
  }
  grid += `</tbody></table>`;

  const avail = gradeAvailableSlots(g), assigned = gradeAssignedHours(g);
  const match = avail === assigned;
  // 科目節數：已勾選的科目列在上方（可調節數），未勾選的科目收進摺疊區，避免卡片過長
  const subjPill = s => `<span class="pill" style="background:${s.color};color:${subjTextColor(s)}">${esc(s.name)}</span>${s.allowGrouping ? ' 👥' : ''}`;
  const onSubs = state.subjects.filter(s => !!gradeSubjHours(g, s.id));
  const offSubs = state.subjects.filter(s => !gradeSubjHours(g, s.id));
  const subjCards = onSubs.map(s => {
    const sh = gradeSubjHours(g, s.id);
    return `<div class="subjh-card" style="--sc:${s.color}">
      <button class="subjh-x" data-action="grade-subj-off" data-gid="${g.id}" data-sid="${s.id}" title="移除此科目">✕</button>
      <div class="subjh-name">${subjPill(s)}</div>
      <div class="subjh-hrs"><input type="number" min="0" max="40" data-change="grade-subj-hours" data-gid="${g.id}" data-sid="${s.id}" value="${sh.hours}"> 節</div>
    </div>`;
  }).join('');
  const offChecks = offSubs.map(s =>
    `<label class="checkbox" style="font-weight:400"><input type="checkbox" data-change="grade-subj-on" data-gid="${g.id}" data-sid="${s.id}">
      ${subjPill(s)}</label>`).join('');

  const allDone = state.grades.every(x => gradeComplete(x));
  const badge = allDone ? '<span class="pill green">✓ 全年級完成</span>' : '<span class="pill amber">尚未全部完成</span>';
  const open = gradeFoldOpen ? 'open' : '';
  return `<details class="grade-fold" ${open}>
    <summary>🏫 年級設定（節次表＋科目節數） ${badge}</summary>
    <div class="grade-fold-body">
      <div class="hint" style="margin-bottom:10px;color:var(--muted)">為每個年級設定「哪些節有課」與「各科一周節數」，兩者總和相符才算完成 ✓。</div>
      <div class="gtabs no-print">${nav}</div>
      <div class="grade-cols">
        <div class="card"><div class="card-body">
          <h4 style="margin-top:0">2.1 節次表 — ${esc(g.name)}（點格切換是否上課）</h4>
          <div class="grid-wrap">${grid}</div>
          <p class="hint" style="color:var(--muted);margin-top:8px">可用節格數（打勾總數）：<b>${avail}</b> 節。上課日欄位由「設定 ▸ 上課日」決定；午休等分隔節在「設定 ▸ 節次定義」設。</p>
        </div></div>
        <div class="card"><div class="card-body">
          <h4 style="margin-top:0">2.2 科目節數 — ${esc(g.name)}</h4>
          ${onSubs.length ? `<div class="subjh-cards">${subjCards}</div>`
            : '<p class="hint" style="color:var(--muted);margin:0">尚未加開任何科目，請從下方「加開科目」勾選要開課的科目並填節數。</p>'}
          ${offSubs.length ? `<details class="offsubj-fold"><summary>＋ 加開科目（還有 ${offSubs.length} 科未開）</summary><div class="offsubj-list">${offChecks}</div></details>` : ''}
          <div class="total-badge ${match ? 'ok' : 'bad'}">
            已配 <b>${assigned}</b> / 應配 <b>${avail}</b> 節　${match ? '✓ 相符' : (assigned > avail ? '✗ 超過 ' + (assigned - avail) + ' 節' : '✗ 還差 ' + (avail - assigned) + ' 節')}
          </div>
        </div></div>
      </div>
    </div>
  </details>`;
}

/* ==========================================================================
   ② 年級與班級（選年級 → 課程強制沿用年級；協同教學）
   ========================================================================== */
const classGrade = c => c ? gradeById(c.gradeId) : null;   // null-guard：殘留孤兒格(已刪班級)不得讓整頁崩潰
// v09.12 依年級順序、再依班級代號/名稱排序（全校總表、配課矩陣共用）
function sortedClasses() {
  return state.classes.slice().sort((a, b) => {
    const ga = state.grades.findIndex(g => g.id === a.gradeId);
    const gb = state.grades.findIndex(g => g.id === b.gradeId);
    if (ga !== gb) return ga - gb;
    return String(a.code || a.name || '').localeCompare(String(b.code || b.name || ''), 'zh-Hant');
  });
}
const classSubjectHours = c => { const g = classGrade(c); return g ? g.subjectHours : []; };
const classWeeklyHours = c => classSubjectHours(c).reduce((s, x) => s + (x.hours || 0), 0);
const sameGradeOtherClasses = c => state.classes.filter(x => x.id !== c.id && x.gradeId === c.gradeId);
function classCoteachPartners(c, sid) {
  const g = c.coteach && c.coteach[sid]; if (!g) return [];
  return state.classes.filter(x => x.id !== c.id && x.coteach && x.coteach[sid] === g).map(x => x.id);
}
function cleanupCoteachSingletons(sid) {
  const count = {};
  state.classes.forEach(c => { const g = c.coteach && c.coteach[sid]; if (g) count[g] = (count[g] || 0) + 1; });
  state.classes.forEach(c => { const g = c.coteach && c.coteach[sid]; if (g && count[g] < 2) delete c.coteach[sid]; });
}
function setClassCoteach(sid, classId, partnerIds) {
  const me = classById(classId); if (!me) return;
  const full = [classId, ...partnerIds.filter(id => id !== classId && classById(id))];
  const oldGid = me.coteach && me.coteach[sid];
  if (full.length <= 1) { if (me.coteach) delete me.coteach[sid]; }
  else {
    const gid = oldGid || uid();
    full.forEach(id => { const c = classById(id); c.coteach = c.coteach || {}; c.coteach[sid] = gid; });
    if (oldGid) state.classes.forEach(c => { if (c.coteach && c.coteach[sid] === oldGid && !full.includes(c.id)) delete c.coteach[sid]; });
  }
  cleanupCoteachSingletons(sid);
}
function removeClassFromAllCoteach(classId) {
  const c = classById(classId); if (!c || !c.coteach) return;
  const subs = Object.keys(c.coteach);
  delete c.coteach;
  subs.forEach(sid => cleanupCoteachSingletons(sid));
}

// 班級卡片（點卡片編輯；「科目/協同」與刪除鈕在卡片底部）
function classCards() {
  const head = `<div class="page-head" style="margin-top:20px"><h3 style="margin:0;font-size:17px">🏷️ 班級</h3><button class="btn" data-action="add-class">＋ 新增班級</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">班級選定年級後，課程（科目與一周節數）自動沿用該年級設定。<b>點卡片可編輯</b>班級（含課程與協同教學設定）；刪除鈕在卡片右下角。</div>`;
  if (state.classes.length === 0) return head + emptyCard('尚無班級', '點右上「＋ 新增班級」建立，例如：一年忠班、一年孝班。新增後課程沿用其年級。');
  const cards = sortedClasses().map(c => {
    const g = classGrade(c);
    const incomplete = g && !gradeComplete(g);
    return `<div class="class-card" data-action="edit-class" data-id="${c.id}">
      <div class="cc-head">
        <span class="cc-name">${esc(c.name)}</span>
        ${c.code ? `<span class="pill blue">代號 ${esc(c.code)}</span>` : ''}
      </div>
      <div class="cc-meta">${classSubjectHours(c).length} 科 / ${classWeeklyHours(c)} 節</div>
      ${incomplete ? '<div class="cc-warn"><span class="pill red" title="該年級科目節數尚未相符">年級未完成</span></div>' : ''}
      <button class="icon-btn cc-del" data-action="del-class" data-id="${c.id}" title="刪除班級">🗑️</button>
    </div>`;
  }).join('');
  return head + `<div class="class-cards">${cards}</div>`;
}
// 班級編輯：基本資料（名稱／代號／年級）＋ 課程與協同 合一
function classModal(existing) {
  if (state.grades.length === 0) { openModal({ title: '無法新增', body: '<p>系統應有六個年級，請重整。</p>' }); return; }
  const c = existing || { name: '', gradeId: state.grades[0].id };
  const gradeOpts = state.grades.map(g => `<option value="${g.id}" ${g.id === c.gradeId ? 'selected' : ''}>${esc(g.name)}${gradeComplete(g) ? '' : '（節數未完成）'}</option>`).join('');
  // 協同教學區：僅既有班級顯示（新班尚無課程）
  let coteachSection = '';
  if (existing) {
    const subs = classSubjectHours(c);
    const others = sameGradeOtherClasses(c);
    if (subs.length === 0) {
      coteachSection = `<div class="hint" style="color:var(--muted);margin-top:8px">此班年級尚未於「② 年級與班級」設定科目節數，完成年級設定後即可在此設定協同教學。</div>`;
    } else {
      const rows = subs.map(sh => {
        const s = subjectById(sh.subjectId); if (!s) return '';
        const partners = classCoteachPartners(c, sh.subjectId);
        const picker = others.length === 0
          ? `<span class="hint" style="color:var(--muted)">（同年級無其他班）</span>`
          : others.map(o => `<label class="checkbox" style="font-weight:400;display:inline-flex;margin-right:12px">
              <input type="checkbox" data-coteach-subj data-sid="${sh.subjectId}" data-cid="${o.id}" ${partners.includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
        return `<tr>
          <td style="white-space:nowrap"><span class="pill" style="background:${s.color};color:${subjTextColor(s)}">${esc(s.name)}</span>${s.allowGrouping ? ' 👥' : ''}</td>
          <td style="white-space:nowrap">${sh.hours} 節</td>
          <td>🔗 ${picker}</td>
        </tr>`;
      }).join('');
      coteachSection = `<details class="subj-adv" open style="margin-top:14px"><summary>🔗 課程與協同教學</summary>
        <p class="hint" style="color:var(--muted);margin:6px 0 8px">節數沿用年級、不可改。勾選要「同時段一起上」的其他班（同年級同科目）；協同班級彼此不計教室衝堂。<b>若上方改了年級，儲存後協同會重設。</b></p>
        <table class="data"><thead><tr><th>科目</th><th>節數</th><th>協同教學班級</th></tr></thead><tbody>${rows}</tbody></table></details>`;
    }
  }
  openModal({
    title: existing ? '編輯班級' : '新增班級',
    wide: !!existing,
    body: `<div class="field-row">
        <label class="field" style="flex:2"><span>班級名稱</span><input type="text" id="cName" value="${esc(c.name)}" placeholder="例：一年忠班"></label>
        <label class="field" style="flex:1"><span>數字代號（填課檔名用，如 01）</span><input type="text" id="cCode" value="${esc(c.code || '')}" placeholder="例：01" inputmode="numeric"></label>
      </div>
      <label class="field"><span>年級</span><select id="cGrade">${gradeOpts}</select></label>
      <p class="hint" style="color:var(--muted);margin:0">課程（科目＋節數）沿用所選年級於「② 年級與班級」的設定；數字代號由排課者編排，用來組成線上填課檔名。</p>
      ${coteachSection}`,
    onSave: () => {
      const name = $('#cName').value.trim();
      if (!name) { toast('請輸入班級名稱'); return false; }
      const gradeId = $('#cGrade').value;
      const code = ($('#cCode').value || '').trim();
      if (existing) {
        const gradeChanged = existing.gradeId !== gradeId;
        if (gradeChanged) removeClassFromAllCoteach(existing.id); // 換年級 → 協同失效，忽略下方勾選
        existing.name = name; existing.gradeId = gradeId; existing.code = code;
        if (!gradeChanged) {
          classSubjectHours(existing).forEach(sh => {
            const checked = Array.from(document.querySelectorAll(`#modalRoot input[data-coteach-subj][data-sid="${sh.subjectId}"]:checked`)).map(el => el.dataset.cid);
            setClassCoteach(sh.subjectId, existing.id, checked);
          });
        }
      } else state.classes.push({ id: uid(), name, gradeId, code, coteach: {} });
      save(); render(); toast('已儲存班級');
      return true;
    },
  });
}
function classDetailModal(c) {
  const subs = classSubjectHours(c);
  if (subs.length === 0) {
    openModal({ title: `${c.name}`, body: `<p>此班年級（${esc(gradeName(c.gradeId))}）尚未於「② 年級與班級」設定任何科目節數。請先完成年級設定。</p>` });
    return;
  }
  const others = sameGradeOtherClasses(c);
  const rows = subs.map(sh => {
    const s = subjectById(sh.subjectId); if (!s) return '';
    const partners = classCoteachPartners(c, sh.subjectId);
    const picker = others.length === 0
      ? `<span class="hint" style="color:var(--muted)">（同年級無其他班）</span>`
      : others.map(o => `<label class="checkbox" style="font-weight:400;display:inline-flex;margin-right:12px">
          <input type="checkbox" data-coteach-subj data-sid="${sh.subjectId}" data-cid="${o.id}" ${partners.includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
    return `<tr>
      <td style="white-space:nowrap"><span class="pill" style="background:${s.color};color:${subjTextColor(s)}">${esc(s.name)}</span>${s.allowGrouping ? ' 👥' : ''}</td>
      <td style="white-space:nowrap">${sh.hours} 節</td>
      <td>🔗 ${picker}</td>
    </tr>`;
  }).join('');
  openModal({
    title: `${c.name}　課程與協同（${gradeName(c.gradeId)}）`,
    wide: true,
    saveLabel: '儲存協同',
    body: `<p class="hint" style="color:var(--muted);margin-top:0">節數沿用年級、不可改。勾選要「同時段一起上」的其他班（同年級同科目）；協同班級彼此不計教室衝堂。</p>
      <table class="data"><thead><tr><th>科目</th><th>節數</th><th>協同教學班級</th></tr></thead><tbody>${rows}</tbody></table>`,
    onSave: () => {
      subs.forEach(sh => {
        const checked = Array.from(document.querySelectorAll(`#modalRoot input[data-coteach-subj][data-sid="${sh.subjectId}"]:checked`)).map(el => el.dataset.cid);
        setClassCoteach(sh.subjectId, c.id, checked);
      });
      save(); render(); toast('已儲存協同設定');
      return true;
    },
  });
}
function delClass(id) {
  const c = classById(id); if (!c) return;
  confirmDelete(`刪除班級「${c.name}」？`, () => {
    removeClassFromAllCoteach(id);
    for (const k in state.slots) if (k.startsWith(id + '|')) { delete state.slots[k]; delete state.slotTeachers[k]; if (state.slotContent) delete state.slotContent[k]; }
    state.teachers.forEach(t => { if (t.homeroomClassId === id) t.homeroomClassId = ''; }); // 清除指向此班的導師設定
    state.classes = state.classes.filter(x => x.id !== id);
    pruneOrphanData();   // 一併清掉配課/鎖定/自編/代課等指向此班的殘留，避免孤兒資料
  });
}

/* ==========================================================================
   ③ 教師 / 教師配課 / 全校交叉檢核
   ========================================================================== */
const teacherLoadSum = t => (t.load || []).reduce((s, L) => s + (L.hours || 0), 0);
const classSubjectRequired = (classId, sid) => { const c = classById(classId); if (!c) return 0; const sh = gradeSubjHours(classGrade(c) || {}, sid); return sh ? sh.hours : 0; };
function loadsForClassSubject(classId, sid) {
  const out = [];
  state.teachers.forEach(t => (t.load || []).forEach(L => { if (L.classId === classId && L.subjectId === sid) out.push({ teacher: t, hours: L.hours, roomId: L.roomId || '' }); }));
  return out;
}
function roomsForClassSubject(classId, sid) { return [...new Set(loadsForClassSubject(classId, sid).map(x => x.roomId).filter(Boolean))]; }
function roomsLabelCS(classId, sid) { return roomsForClassSubject(classId, sid).map(roomName).join('｜'); }
function checkStaffing() {
  const problems = [];
  state.classes.forEach(c => {
    classSubjectHours(c).forEach(sh => {
      const required = sh.hours;
      const s = subjectById(sh.subjectId);
      const loads = loadsForClassSubject(c.id, sh.subjectId);
      const teacherNames = loads.map(x => `${x.teacher.name}(${x.hours}節)`).join('、') || '（未指派）';
      if (loads.length === 0) { problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: '未指派老師', teacherNames }); return; }
      if (s && s.allowGrouping) {
        const bad = loads.filter(x => x.hours !== required);
        if (bad.length) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: `分組節數不符（每組應各 ${required} 節）`, teacherNames });
      } else if (s && s.splitTeachers) {
        // 分節上課：多師分攤，加總＝需求即可，允許多位老師
        const total = loads.reduce((a, x) => a + x.hours, 0);
        if (total !== required) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: total < required ? `分節加總不足（少 ${required - total} 節）` : `分節加總超過（多 ${total - required} 節）`, teacherNames });
      } else {
        const total = loads.reduce((a, x) => a + x.hours, 0);
        if (total !== required) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: total < required ? `缺漏（少 ${required - total} 節）` : `超過（多 ${total - required} 節）`, teacherNames });
        else if (loads.length > 1) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: '非分組科目卻有多位老師（如需分攤請將科目設為「分節上課」）', teacherNames });
      }
    });
  });
  return problems;
}
// v09.01 沒有級任導師的班級名稱清單（自編/鎖定要用導師身分，故納入全校檢查）
function unsetHomerooms() {
  return state.classes.filter(c => !state.teachers.some(t => t.type === '級任' && t.homeroomClassId === c.id)).map(c => c.name);
}
// v09.01 影響「全校配課＋導師」結果的資料簽章；任一相關欄位變動即改變 → 需重新檢查
function staffingSignature() {
  return JSON.stringify({
    c: state.classes.map(c => ({ i: c.id, g: c.gradeId, o: c.coteach || {} })),
    t: state.teachers.map(t => ({ i: t.id, y: t.type, h: t.homeroomClassId || '', l: (t.load || []).map(L => [L.classId, L.subjectId, L.hours]) })),
    g: state.grades.map(g => ({ i: g.id, s: g.subjectHours || [] })),
    s: state.subjects.map(s => ({ i: s.id, a: !!s.allowGrouping, p: !!s.splitTeachers })),
  });
}
function staffingClear() { return checkStaffing().length === 0 && unsetHomerooms().length === 0; }
// v09.01 是否已通過「檢查全校配課」：資料無誤 且 已在目前資料狀態下按過檢查（簽章相符）
function staffingConfirmed() { return staffingClear() && state.staffingOkSig === staffingSignature(); }

function viewTeachers() {
  const problems = checkStaffing();
  const noHr = unsetHomerooms();
  const confirmed = staffingConfirmed();
  const statusCard = state.classes.length === 0
    ? `<div class="card"><div class="card-body"><span style="color:var(--muted)">尚無班級，請先完成「② 年級與班級」。</span></div></div>`
    : `<div class="card"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>${confirmed
          ? '<b style="color:var(--ok)">✓ 全校配課與導師設定已檢查通過</b>　已解鎖 ④ 排課。'
          : `<b style="color:var(--danger)">⚠ 尚未通過全校檢查</b>　${problems.length ? `配課問題 ${problems.length} 項；` : ''}${noHr.length ? `未設導師班級 ${noHr.length} 個（${esc(noHr.join('、'))}）；` : ''}${(!problems.length && !noHr.length) ? '資料已齊，請按右側「檢查全校配課」完成確認。' : '修正後請按「檢查全校配課」。'}`}
          <div style="color:var(--muted);font-size:12px;margin-top:4px">④ 排課需先在此通過「檢查全校配課」（含每班均已設定級任導師）。</div>
        </div>
        <button class="${confirmed ? 'ghost' : 'btn'}" data-action="check-staffing">檢查全校配課</button>
      </div></div>`;
  const head = coreHead('teachers', '<button class="btn" data-action="add-teacher">＋ 新增教師</button>') +
    `<div class="hint" style="margin-bottom:12px;color:var(--muted)">填入教師基本資料與不排課時段，並設定其配課（教哪個班的哪一科幾節）。每位教師配課合計須等於其每周授課時數才可儲存。</div>`;
  if (state.teachers.length === 0) return head + statusCard + emptyCard('尚無教師', '點右上「＋ 新增教師」建立並設定配課。');
  const cards = state.teachers.map(t => {
    const sum = teacherLoadSum(t); const match = sum === (t.weeklyHours || 0);
    const hr = t.type === '級任' && t.homeroomClassId && classById(t.homeroomClassId)
      ? `<span class="pill blue">🎓 ${esc(classById(t.homeroomClassId).name)}導師</span>` : '';
    const unav = (t.unavailable || []).length;
    const clr = match ? 'var(--ok)' : 'var(--danger)';
    return `<div class="teacher-card" data-action="edit-teacher" data-id="${t.id}">
      <div class="tc-head">
        <span class="tc-name">${esc(t.name)}</span>
        <span class="pill gray">${esc(t.type || '')}</span>
        ${hr}
      </div>
      <div class="tc-meta">
        <div>授課 <b style="color:${clr}">${sum}</b> / ${t.weeklyHours || 0} 節 <span style="color:${clr};font-weight:700">${match ? '✓' : '✗'}</span></div>
        <div>配課 ${(t.load || []).length} 筆${unav ? ` · 不排課 ${unav}` : ''}</div>
      </div>
      <button class="icon-btn tc-del" data-action="del-teacher" data-id="${t.id}" title="刪除教師">🗑️</button>
    </div>`;
  }).join('');
  const matrixCard = state.classes.length ? `<div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h4 style="margin:0">🧮 配課矩陣（班 × 科）</h4>
        <button class="ghost" data-action="toggle-matrix">${showLoadMatrix ? '收合 ▲' : '展開 ▼'}</button>
      </div>
      ${showLoadMatrix ? loadMatrixHTML() : '<p style="color:var(--muted);margin:8px 0 0">展開可一眼看出每班每科由誰配課、哪裡有缺口（未配足／超額）。</p>'}
    </div></div>` : '';
  return head + statusCard + `<div class="teacher-cards">${cards}</div>` + matrixCard;
}
// v09.12 班×科配課矩陣：列＝班級（依年級序）、欄＝有任一年級需上的科目；格顯示配課教師與 已配/應排，缺口紅、超額橘
function loadMatrixHTML() {
  const classes = sortedClasses();
  const cols = state.subjects.filter(s => classes.some(c => classSubjectRequired(c.id, s.id) > 0));
  if (!classes.length || !cols.length) return '<div class="empty">尚無可顯示的配課資料（請先完成年級科目節數與班級）。</div>';
  let gaps = 0;
  const head = `<tr><th class="corner">班級＼科目</th>${cols.map(s => `<th><span class="mx-dot" style="background:${s.color || '#94a3b8'}"></span>${esc(s.name)}</th>`).join('')}</tr>`;
  const body = classes.map(c => {
    const tds = cols.map(s => {
      const req = classSubjectRequired(c.id, s.id);
      if (!req) return `<td class="mx-na"></td>`;
      const subj = subjectById(s.id);
      const loads = loadsForClassSubject(c.id, s.id);
      const names = loads.map(x => x.teacher.name).join('、');
      const sum = loads.reduce((n, x) => n + (x.hours || 0), 0);
      let cls, hoursLabel, tip;
      if (!loads.length) {
        cls = 'short'; hoursLabel = `0/${req}`; tip = `${c.name}／${s.name}：應排 ${req} 節（未指派）`; gaps++;
      } else if (subj && subj.allowGrouping) {
        // 分組教學：多師「同一節」平行分組上，每組各應排 req 節，不相加
        const allFull = loads.every(x => x.hours === req);
        cls = allFull ? 'ok' : 'short'; if (!allFull) gaps++;
        hoursLabel = allFull ? `${req}/${req} 👥` : '👥 節數不符';
        tip = `${c.name}／${s.name}：👥 分組教學，每組應各 ${req} 節（同一節平行上，不相加）｜${loads.map(x => x.teacher.name + ' ' + x.hours + '節').join('、')}`;
      } else {
        // 分節上課 / 單一教師：加總＝req
        cls = sum === req ? 'ok' : (sum < req ? 'short' : 'over'); if (sum < req) gaps++;
        tip = `${c.name}／${s.name}：${subj && subj.splitTeachers ? '✂️ 分節，多師加總' : ''}應排 ${req} 節、已配 ${sum} 節（${names}）`;
        hoursLabel = `${sum}/${req}`;
      }
      return `<td class="mx-${cls}" title="${esc(tip)}">
        <div class="mx-t">${esc(names || '缺')}</div><div class="mx-h">${hoursLabel}</div></td>`;
    }).join('');
    return `<tr><th class="mx-row">${esc(c.name)}</th>${tds}</tr>`;
  }).join('');
  const legend = `<div class="mx-legend no-print">🟩 已配足　🟥 未配足／缺　🟧 超額　·　空白＝該班無此科　·　${gaps ? `<b style="color:var(--danger)">尚有 ${gaps} 個缺口</b>` : '<b style="color:var(--ok)">配課無缺口 ✓</b>'}</div>`;
  return `<div class="grid-wrap" style="margin-top:10px"><table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>${legend}`;
}

let modalLoad = []; // 教師 modal 編輯中的配課 [{classId, subjectId, hours}]
let editingTeacherId = null; // 正在編輯的教師 id（新增時為 null）；剩餘節數計算要排除此人自己的舊配課
// 該(班,科)已被「其他教師」配走的節數（不含正在編輯的教師，因其配課即為 modalLoad）
function loadHoursByOtherTeachers(classId, sid) {
  let sum = 0;
  state.teachers.forEach(t => {
    if (editingTeacherId && t.id === editingTeacherId) return;
    (t.load || []).forEach(L => { if (L.classId === classId && L.subjectId === sid) sum += (L.hours || 0); });
  });
  return sum;
}
// 目前 modal 內其他列（排除 rowIdx）對同(班,科)已填的節數
function modalHoursOtherRows(classId, sid, rowIdx) {
  return modalLoad.reduce((s, L, i) => (i !== rowIdx && L.classId === classId && L.subjectId === sid) ? s + (L.hours || 0) : s, 0);
}
// 這一列對該(班,科)還可填的剩餘節數。分組科目：每組各需 required（僅扣本 modal 同科其他列，防同一師重覆加）；非分組：required 扣其他教師與本 modal 其他列
function remainingForRow(classId, sid, rowIdx) {
  const required = classSubjectRequired(classId, sid);
  const s = subjectById(sid);
  if (s && s.allowGrouping) return Math.max(0, required - modalHoursOtherRows(classId, sid, rowIdx));
  return Math.max(0, required - loadHoursByOtherTeachers(classId, sid) - modalHoursOtherRows(classId, sid, rowIdx));
}
// 該班第一個「這一列還可選」的科目 id（剩餘>0；分組科目一律可選），找不到回 ''
function firstAvailableSubject(classId, rowIdx) {
  const c = classById(classId); if (!c) return '';
  const sh = classSubjectHours(c).find(x => {
    const s = subjectById(x.subjectId);
    return (s && s.allowGrouping) || remainingForRow(classId, x.subjectId, rowIdx) > 0;
  });
  return sh ? sh.subjectId : '';
}
function loadEditorHTML() {
  if (state.classes.length === 0) return `<div class="hint" style="color:var(--muted)">尚無班級，請先到「② 年級與班級」建立。</div>`;
  const clsOpts = sel => state.classes.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}（${esc(gradeName(c.gradeId))}）</option>`).join('');
  const subOpts = (classId, sel, rowIdx) => {
    const c = classById(classId); const subs = c ? classSubjectHours(c) : [];
    if (!subs.length) return `<option value="">（該班無科目）</option>`;
    const opts = subs.map(sh => {
      const sid = sh.subjectId; const s = subjectById(sid);
      const grouping = !!(s && s.allowGrouping);
      const rem = remainingForRow(classId, sid, rowIdx);
      const isSel = sid === sel;
      if (!grouping && rem <= 0 && !isSel) return ''; // 已被配滿：不顯示（除非本列正選著它）
      const tag = grouping ? `分組·每組${sh.hours}節` : (rem >= sh.hours ? `需${sh.hours}節` : `剩${rem}節`);
      return `<option value="${sid}" ${isSel ? 'selected' : ''}>${esc(subjectName(sid))}（${tag}）</option>`;
    }).filter(Boolean);
    if (!opts.length) return `<option value="">（該班科目皆已配滿）</option>`;
    return opts.join('');
  };
  const rOpts = sel => `<option value="">— 無教室 —</option>` + state.rooms.map(r => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const rows = modalLoad.map((L, i) => {
    const rem = remainingForRow(L.classId, L.subjectId, i);
    return `<div class="group-row" data-idx="${i}">
      <select class="ld-class" data-change="load-class" data-idx="${i}">${clsOpts(L.classId)}</select>
      <select class="ld-subject" data-change="load-subject" data-idx="${i}">${subOpts(L.classId, L.subjectId, i)}</select>
      <input type="number" class="ld-hours" data-change="load-hours" data-idx="${i}" min="0" max="${rem}" value="${L.hours || ''}" placeholder="節" title="剩餘可填 ${rem} 節" style="width:56px">
      <select class="ld-room" title="專科教室（可留空）">${rOpts(L.roomId)}</select>
      <button type="button" class="icon-btn" data-action="del-load-row" data-idx="${i}">🗑️</button>
    </div>`;
  }).join('');
  return rows + `<button type="button" class="ghost" data-action="add-load-row" style="margin-top:6px;padding:5px 10px;font-size:13px">＋ 新增配課（班級 → 科目 → 節數 → 教室）</button>`;
}
function syncLoadFromDOM() {
  modalLoad = Array.from(document.querySelectorAll('#loadEditor .group-row')).map(r => ({
    classId: r.querySelector('.ld-class').value,
    subjectId: r.querySelector('.ld-subject').value,
    hours: parseInt(r.querySelector('.ld-hours').value, 10) || 0,
    roomId: r.querySelector('.ld-room') ? r.querySelector('.ld-room').value : '',
  }));
}
function refreshLoadEditor() { const el = $('#loadEditor'); if (el) el.innerHTML = loadEditorHTML(); }
function updateLoadSum() {
  syncLoadFromDOM();
  const wh = parseInt(($('#tWeekly') || {}).value, 10) || 0;
  const sum = modalLoad.reduce((s, L) => s + (L.hours || 0), 0);
  const el = $('#loadSum'); if (!el) return;
  const m = sum === wh;
  el.className = 'total-badge ' + (m ? 'ok' : 'bad');
  el.innerHTML = `配課合計 <b>${sum}</b> / 每周授課 <b>${wh}</b> 節　${m ? '✓ 相符' : '✗ 需相符才可儲存'}`;
}
function teacherModal(existing) {
  const t = existing || { name: '', type: '級任', weeklyHours: 20, unavailable: [], load: [] };
  editingTeacherId = existing ? existing.id : null;
  modalLoad = (t.load || []).map(L => ({ ...L }));
  const typeOpts = TEACHER_TYPES.map(x => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('');
  const hrClsOpts = `<option value="">（未指定）</option>` + state.classes.map(c => `<option value="${c.id}" ${t.homeroomClassId === c.id ? 'selected' : ''}>${esc(c.name)}（${esc(gradeName(c.gradeId))}）</option>`).join('');
  const days = activeDays(); const un = new Set(t.unavailable || []);
  let grid = `<table class="avail"><thead><tr><th></th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of lessonPeriods()) {
    grid += `<tr><th>${esc(p.label)}</th>`;
    for (const d of days) { const s = d + '|' + p.id; grid += `<td class="slot ${un.has(s) ? 'off' : ''}" data-action="toggle-avail" data-slot="${s}">${un.has(s) ? '✕' : ''}</td>`; }
    grid += `</tr>`;
  }
  grid += `</tbody></table>`;
  openModal({
    title: existing ? '編輯教師' : '新增教師',
    wide: true,
    body: `
      <div class="field-row">
        <label class="field"><span>姓名</span><input type="text" id="tName" value="${esc(t.name)}"></label>
        <label class="field"><span>身分別</span><select id="tType" data-change="teacher-type">${typeOpts}</select></label>
        <label class="field"><span>每周授課時數</span><input type="number" id="tWeekly" data-change="weekly-hours" min="0" max="40" value="${t.weeklyHours || 0}"></label>
        <label class="field"><span>單日上限（0＝用全域）</span><input type="number" id="tMaxDay" min="0" max="20" value="${t.maxPerDay || 0}"></label>
      </div>
      <div class="field-row" style="margin-bottom:6px;gap:12px">
        <label class="field" style="max-width:340px"><span>Google Email（線上填課／代課分享用，可留空）</span><input type="email" id="tEmail" value="${esc(t.email || '')}" placeholder="學校 @ttct.edu.tw 或個人 Gmail"></label>
        <label class="field" id="homeroomField" style="max-width:320px;display:${t.type === '級任' ? '' : 'none'}"><span>擔任導師的班級（級任）</span><select id="tHomeroom">${hrClsOpts}</select></label>
      </div>
      <label class="field" style="margin-bottom:4px"><span>教師配課（班級 → 科目 → 節數）</span></label>
      <div id="loadEditor">${loadEditorHTML()}</div>
      <div id="loadSum" class="total-badge"></div>
      <label class="field" style="margin:14px 0 4px"><span>不排課時段（點格切換，✕＝不排）</span></label>
      <div id="availGrid">${grid}</div>`,
    onSave: () => {
      const name = $('#tName').value.trim();
      if (!name) { toast('請輸入姓名'); return false; }
      const weekly = parseInt($('#tWeekly').value, 10) || 0;
      syncLoadFromDOM();
      const load = modalLoad.filter(L => L.classId && L.subjectId && L.hours > 0);
      // 防呆：任一列不得超過該(班,科)剩餘可配節數（分組科目上限為每組 required）
      for (let i = 0; i < modalLoad.length; i++) {
        const L = modalLoad[i]; if (!L.classId || !L.subjectId || !(L.hours > 0)) continue;
        const rem = remainingForRow(L.classId, L.subjectId, i);
        if (L.hours > rem) { toast(`「${subjectName(L.subjectId)}」超過剩餘可配 ${rem} 節`); return false; }
      }
      const sum = load.reduce((s, L) => s + L.hours, 0);
      if (sum !== weekly) { toast(`配課合計 ${sum} 節與每周授課 ${weekly} 節不符，無法儲存`); return false; }
      const unavailable = Array.from(document.querySelectorAll('#availGrid td.off')).map(td => td.dataset.slot);
      const type = $('#tType').value;
      const homeroomClassId = (type === '級任' && $('#tHomeroom')) ? $('#tHomeroom').value : '';
      const email = $('#tEmail') ? $('#tEmail').value.trim() : '';   // v10.04 所有教師皆可填 email（代課分享用）
      const data = { name, type, weeklyHours: weekly, maxPerDay: parseInt($('#tMaxDay').value, 10) || 0, homeroomClassId, email, unavailable, load };
      if (existing) Object.assign(existing, data); else state.teachers.push({ id: uid(), ...data });
      save(); render(); toast('已儲存教師');
      return true;
    },
  });
  updateLoadSum();
}
function delTeacher(id) {
  const t = teacherById(id); if (!t) return;
  confirmDelete(`刪除教師「${t.name}」？其配課將一併移除。`, () => {
    state.teachers = state.teachers.filter(x => x.id !== id);
    // 清掉分節上課中指派給此師的格子（該節課因老師移除而清空）
    for (const k in state.slotTeachers) { if (state.slotTeachers[k] === id) { delete state.slotTeachers[k]; delete state.slots[k]; } }
    pruneOrphanData();
  });
}
// v11 資料自癒：清除「指向已刪除班級/科目/教師」的殘留（曾造成刪班後排課頁 computeConflicts 崩潰＝看似鎖死）。
// 冪等；回傳清除筆數。載入時與刪除後都會呼叫。
function pruneOrphanData() {
  const cls = new Set(state.classes.map(c => c.id));
  const subj = new Set(state.subjects.map(s => s.id));
  const tch = new Set(state.teachers.map(t => t.id));
  let removed = 0;
  // 1) 孤兒課格：班級或科目已不存在；分節格的指定老師已不存在
  for (const k in state.slots) {
    const cId = k.split('|')[0]; const sid = state.slots[k];
    const splitOrphan = state.slotTeachers[k] && !tch.has(state.slotTeachers[k]);
    if (!cls.has(cId) || !subj.has(sid) || splitOrphan) { delete state.slots[k]; delete state.slotTeachers[k]; if (state.slotContent) delete state.slotContent[k]; removed++; }
  }
  // 2) 依附課格的清單/備份，只保留仍存在的格
  if (Array.isArray(state.lockedCells)) state.lockedCells = state.lockedCells.filter(k => state.slots[k]);
  if (Array.isArray(state.selfCells)) state.selfCells = state.selfCells.filter(k => cls.has(k.split('|')[0]));
  if (state.selfBackup) for (const k in state.selfBackup) { if (!cls.has(k.split('|')[0]) || !subj.has((state.selfBackup[k] || {}).sid)) delete state.selfBackup[k]; }
  if (state.selfDone) for (const cId in state.selfDone) if (!cls.has(cId)) delete state.selfDone[cId];
  // 3) 教師配課中指向已刪班級/科目的殘留條目
  state.teachers.forEach(t => { if (Array.isArray(t.load)) { const before = t.load.length; t.load = t.load.filter(L => cls.has(L.classId) && subj.has(L.subjectId)); removed += before - t.load.length; } });
  // 4) 班級協同設定中指向已刪科目的殘留
  state.classes.forEach(c => { if (c.coteach) for (const sid in c.coteach) if (!subj.has(sid)) delete c.coteach[sid]; });
  // 5) 代課記錄中指向已刪班級的指派/週覆蓋（保留記錄本身）；assignments 鍵＝班|天|節、weekOverrides 鍵＝週|班|天|節
  (state.substitutions || []).forEach(r => {
    if (r.assignments) for (const k in r.assignments) { if (!cls.has(k.split('|')[0])) delete r.assignments[k]; }
    if (r.weekOverrides) for (const k in r.weekOverrides) { if (!cls.has(k.split('|')[1])) delete r.weekOverrides[k]; }
  });
  return removed;
}
function staffingReportModal() {
  const problems = checkStaffing();
  const noHr = unsetHomerooms();
  const allClear = problems.length === 0 && noHr.length === 0;
  if (allClear) { state.staffingOkSig = staffingSignature(); save(); render(); }   // 通過→記下簽章、解鎖 ④ 排課
  const hrBlock = noHr.length
    ? `<div class="conflict-banner" style="margin-top:0">⚠ 有 <b>${noHr.length}</b> 個班級<b>尚未設定級任導師</b>：${esc(noHr.join('、'))}
         <div style="color:var(--muted);font-size:12px;margin-top:4px">導師身分是「鎖定→導師自編選課」的依據，每班都需在教師的「級任＋導師班」指定。</div></div>`
    : '';
  const loadBlock = problems.length === 0
    ? `<div class="total-badge ok">✓ 全校各班每科節數皆已由教師配課正確填滿。</div>`
    : `<p style="color:var(--danger);font-weight:700;margin:0 0 6px">有 ${problems.length} 項配課問題，請修正後再排課：</p>
       <table class="data"><thead><tr><th>班級</th><th>科目</th><th>應配</th><th>狀況</th><th>目前老師</th></tr></thead>
       <tbody>${problems.map(p => `<tr>
         <td>${esc(p.className)}</td><td>${esc(p.subjectName)}</td><td>${p.required} 節</td>
         <td style="color:var(--danger);font-weight:600">${esc(p.status)}</td><td>${esc(p.teacherNames)}</td>
       </tr>`).join('')}</tbody></table>`;
  const head = allClear
    ? `<div class="total-badge ok" style="margin-bottom:10px">✓ 全校配課與導師設定皆完成，已解鎖 ④ 排課。</div>`
    : `<p style="color:var(--danger);font-weight:700;margin-top:0">尚有問題需修正，修正後請再按一次「檢查全校配課」。</p>`;
  openModal({ title: '全校配課檢查', wide: true, body: head + hrBlock + loadBlock });
}

/* ==========================================================================
   領域節數參考（v06.00）：建議節數參考表（可編輯）＋ 各年級實配對照
   ========================================================================== */
function viewDomains() {
  const head = subHead('領域節數', '<button class="btn" data-action="add-domain">＋ 新增領域</button>') + `
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">各領域每年級的<b>建議節數</b>（可編輯）與<b>目前實配</b>對照。實配＝「② 年級與班級」已設科目節數，依「① 科目」所選「所屬領域」加總。<b style="color:var(--warn)">下方預設數字為 108 課綱起點，請務必依課綱／貴校實況校對。</b></div>`;
  return head + domainRefAndCmp();
}
// 領域節數的兩張卡（建議節數參考表 + 各年級實配對照）；供獨立分頁與「① 科目」摺疊區共用
function domainRefAndCmp() {
  const grades = state.grades; // g1..g6，順序＝一~六
  const gh = GRADE_NAMES.map(n => `<th style="text-align:center;width:66px">${esc(n.replace('年級', ''))}</th>`).join('');

  // 建議節數參考表（可編輯）
  const refRows = state.domains.map(d => `<tr>
    <td><input type="text" data-change="domain-name" data-id="${d.id}" value="${esc(d.name)}" style="min-width:150px"></td>
    ${grades.map((g, i) => `<td style="text-align:center"><input type="number" min="0" max="40" data-change="domain-hours" data-id="${d.id}" data-grade="${i}" value="${(d.hours && d.hours[i]) || 0}" style="width:52px"></td>`).join('')}
    <td class="row-actions"><button class="icon-btn" data-action="del-domain" data-id="${d.id}">🗑️</button></td>
  </tr>`).join('');
  const refCard = `<div class="card"><div class="card-body">
    <h4 style="margin-top:0">建議節數參考表（每週節數，可編輯）</h4>
    <div class="grid-wrap"><table class="data">
      <thead><tr><th>領域</th>${gh}<th></th></tr></thead><tbody>${refRows}</tbody></table></div>
    <p class="hint" style="color:var(--muted);margin-top:8px">改名稱、改節數或新增／刪除領域皆即時儲存。科目在「① 科目」逐科指定所屬領域。</p>
  </div></div>`;

  // 實配對照矩陣（實配 / 建議）
  const cmpCell = (act, sug) => {
    if (sug === 0 && act === 0) return `<td style="text-align:center;color:var(--muted)">–</td>`;
    const ok = act === sug;
    return `<td style="text-align:center;${ok ? '' : 'background:var(--danger-bg)'}"><b style="color:${ok ? 'var(--ok)' : 'var(--danger)'}">${act}</b><span style="color:var(--muted)"> / ${sug}</span></td>`;
  };
  const cmpRows = state.domains.map(d => `<tr>
    <td>${esc(d.name)}</td>
    ${grades.map(g => cmpCell(gradeDomainActual(g, d.id), domainSuggested(d, g))).join('')}
  </tr>`).join('');
  const unmapped = grades.map(g => gradeUnmappedHours(g));
  const unmapRow = unmapped.some(x => x > 0)
    ? `<tr><td style="color:var(--warn)">未分類科目</td>${grades.map((g, i) => `<td style="text-align:center;color:var(--warn)">${unmapped[i] || '–'}</td>`).join('')}</tr>`
    : '';
  const totalRow = `<tr style="border-top:2px solid var(--line)"><td><b>合計（實配 / 可用格數）</b></td>${grades.map(g => {
    const a = gradeAssignedHours(g), av = gradeAvailableSlots(g), ok = a === av;
    return `<td style="text-align:center"><b style="color:${ok ? 'var(--ok)' : 'var(--danger)'}">${a}</b><span style="color:var(--muted)"> / ${av}</span></td>`;
  }).join('')}</tr>`;
  const cmpCard = `<div class="card"><div class="card-body">
    <h4 style="margin-top:0">各年級實配對照（實配 / 建議）</h4>
    <div class="grid-wrap"><table class="data">
      <thead><tr><th>領域</th>${gh}</tr></thead><tbody>${cmpRows}${unmapRow}${totalRow}</tbody></table></div>
    <p class="hint" style="color:var(--muted);margin-top:8px">
      <b style="color:var(--ok)">綠</b>＝實配與建議相符；<b style="color:var(--danger)">紅底</b>＝不符；「–」＝建議與實配皆 0。
      <b style="color:var(--warn)">未分類科目</b>＝該科在「① 科目」未指定所屬領域，未計入任何領域。合計列的可用格數來自「② 年級與班級」節次表。</p>
  </div></div>`;

  return refCard + cmpCard;
}

/* ==========================================================================
   ④ 排課 + 課表輸出（新模型：格子放科目、老師由 teacher.load 推得）
   ========================================================================== */
let selectedClassId = null;
let selectedSubjectId = null;
let selectedTeacherId = null; // 分節上課：選取的調色盤色塊是哪位老師（非分節為 null）
let outputMode = 'class';
let outputClassId = null;
let outputTeacherId = null;

const subjectPlaced = (classId, sid) => { let n = 0; for (const k in state.slots) if (k.startsWith(classId + '|') && state.slots[k] === sid) n++; return n; };
// 分節上課：某(班,科)已排給某位老師的節數
const placedByTeacher = (classId, sid, tid) => { let n = 0; for (const k in state.slots) if (k.startsWith(classId + '|') && state.slots[k] === sid && state.slotTeachers[k] === tid) n++; return n; };
// 一格實際的上課老師/教室：分節科目→該格記錄的單一老師（含其該科教室）；其餘→該(班,科)全部配課老師（分組平行、單一師）
function slotAssignments(key) {
  const sid = state.slots[key]; if (!sid) return [];
  const classId = key.split('|')[0]; const s = subjectById(sid);
  const loads = loadsForClassSubject(classId, sid);
  if (s && s.splitTeachers) {
    const tid = state.slotTeachers[key]; if (!tid) return [];
    const L = loads.find(x => x.teacher.id === tid);
    return [{ teacherId: tid, roomId: L ? (L.roomId || '') : '' }];
  }
  return loads.map(x => ({ teacherId: x.teacher.id, roomId: x.roomId || '' }));
}
// 一格顯示的老師名稱標籤（分節→該格老師；其餘→全部配課老師）
function slotTeachersLabel(key) {
  const sid = state.slots[key]; if (!sid) return '';
  const classId = key.split('|')[0]; const s = subjectById(sid);
  if (s && s.splitTeachers) { const tid = state.slotTeachers[key]; return tid ? teacherName(tid) : '（未指定老師）'; }
  return subjectTeachersLabel(classId, sid);
}
const classesCoteachTogether = (a, b, sid) => { const ca = classById(a), cb = classById(b); return ca && cb && ca.coteach && cb.coteach && ca.coteach[sid] && ca.coteach[sid] === cb.coteach[sid]; };
const timeToMin = t => { if (!t || typeof t !== 'string') return null; const m = t.match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
// 正常下課(節間)分鐘數＝時間表中相鄰兩上課節的最短間隔；供 R5 判定「大下課」用（各校自適應）
function normalTransitionGap() {
  const arr = state.settings.periods || []; let min = null;
  for (let i = 0; i < arr.length - 1; i++) { if (arr[i].isBreak || arr[i + 1].isBreak) continue; const e = timeToMin(arr[i].end), s = timeToMin(arr[i + 1].start); if (e != null && s != null) { const g = s - e; if (g > 0 && (min == null || g < min)) min = g; } }
  return min;
}
function adjacentOpenPeriod(grade, periodId, day, dir) {
  const arr = state.settings.periods; const i = arr.findIndex(p => p.id === periodId);
  if (i < 0) return null; const nb = arr[i + dir];
  if (!nb || nb.isBreak || !gradePeriodHasDay(grade, nb.id, day)) return null;
  // R5（既定機制）：連堂不得跨越明顯的下課（如大下課）。相鄰兩節時間間隔比「正常下課」多 ≥5 分即視為不相鄰、不可連堂。
  const cur = arr[i], earlier = dir > 0 ? cur : nb, later = dir > 0 ? nb : cur;
  const gap = (timeToMin(earlier.end) != null && timeToMin(later.start) != null) ? timeToMin(later.start) - timeToMin(earlier.end) : null;
  const norm = normalTransitionGap();
  if (gap != null && norm != null && gap - norm >= 5) return null;
  return nb.id;
}
function teacherScheduled(t) {
  return (t.load || []).reduce((sum, L) => {
    const s = subjectById(L.subjectId);
    return sum + ((s && s.splitTeachers) ? placedByTeacher(L.classId, L.subjectId, t.id) : subjectPlaced(L.classId, L.subjectId));
  }, 0);
}

// v09.10 連堂：某(科)在 N 節時要安排幾「對」連堂。有設 consecutivePairs 就取它(夾在 0..floor(N/2))，否則預設盡量成對(floor(N/2))；奇數剩下的 1 節可單獨排、不算錯
function consecutiveTarget(sid, N) {
  const s = subjectById(sid); if (!s || !s.consecutive) return 0;
  const maxPairs = Math.floor(N / 2);
  const P = (s.consecutivePairs != null && s.consecutivePairs !== '') ? parseInt(s.consecutivePairs, 10) : maxPairs;
  return Math.max(0, Math.min(isNaN(P) ? maxPairs : P, maxPairs));
}
function computeConflicts() {
  const conflicts = {};
  const add = (k, r) => { (conflicts[k] = conflicts[k] || []); if (!conflicts[k].includes(r)) conflicts[k].push(r); };
  const byDP = {};
  for (const key in state.slots) {
    const sid = state.slots[key]; const [classId, day, period] = key.split('|'); const dp = day + '|' + period;
    slotAssignments(key).forEach(x => (byDP[dp] = byDP[dp] || []).push({ key, classId, subjectId: sid, teacherId: x.teacherId, roomId: x.roomId }));
  }
  for (const dp in byDP) {
    const list = byDP[dp];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      const coTogether = A.subjectId === B.subjectId && A.classId !== B.classId && classesCoteachTogether(A.classId, B.classId, A.subjectId);
      if (A.teacherId && A.teacherId === B.teacherId && !coTogether) { const msg = '教師衝堂：' + teacherName(A.teacherId); add(A.key, msg); add(B.key, msg); }
      if (A.roomId && A.roomId === B.roomId) {
        const sameOffering = A.classId === B.classId && A.subjectId === B.subjectId;
        if (!sameOffering && !coTogether) { const msg = '教室衝堂：' + roomName(A.roomId); add(A.key, msg); add(B.key, msg); }
      }
    }
  }
  for (const key in state.slots) {
    const [classId, day, period] = key.split('|');
    slotAssignments(key).forEach(x => { const t = teacherById(x.teacherId); if (t && (t.unavailable || []).includes(day + '|' + period)) add(key, '教師不排課時段：' + t.name); });
  }
  for (const key in state.slots) {
    const sid = state.slots[key]; const [classId, day, period] = key.split('|');
    const c = classById(classId); const gid = c && c.coteach && c.coteach[sid]; if (!gid) continue;
    const partners = state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid);
    for (const p of partners) { if (state.slots[slotKey(p.id, day, period)] !== sid) { add(key, '協同未同步：' + p.name + ' 同節未排'); break; } }
  }
  // 連堂：依「連堂次數(對數)」判定。允許 N−2×對數 個節單獨排（不算錯）；只有未成對數超過此額度才標記
  const consecGroups = {};
  for (const key in state.slots) {
    const sid = state.slots[key]; const s = subjectById(sid); if (!s || !s.consecutive) continue;
    const [classId, dayStr, period] = key.split('|');
    (consecGroups[classId + '|' + sid] = consecGroups[classId + '|' + sid] || []).push({ key, classId, day: parseInt(dayStr, 10), period });
  }
  for (const gk in consecGroups) {
    const cells = consecGroups[gk]; const sid = gk.slice(gk.indexOf('|') + 1); const classId = cells[0].classId;
    const g = classGrade(classById(classId)); if (!g) continue;
    const allowedSingles = Math.max(0, cells.length - 2 * consecutiveTarget(sid, cells.length));
    const unpaired = cells.filter(cell => {
      const prev = adjacentOpenPeriod(g, cell.period, cell.day, -1), next = adjacentOpenPeriod(g, cell.period, cell.day, +1);
      const paired = (prev && state.slots[slotKey(classId, cell.day, prev)] === sid) || (next && state.slots[slotKey(classId, cell.day, next)] === sid);
      return !paired;
    });
    unpaired.slice(allowedSingles).forEach(cell => add(cell.key, '連堂未相鄰'));   // 前 allowedSingles 個視為預定的單堂、不標記
  }
  return conflicts;
}
const teacherName = id => (teacherById(id) || {}).name || '?';
function subjectTeachersLabel(classId, sid) { return loadsForClassSubject(classId, sid).map(x => x.teacher.name).join('｜') || '（未指派）'; }

function placeSubject(classId, day, period, sid, teacherId) {
  const dNum = parseInt(day, 10);
  const key = slotKey(classId, day, period);
  const s = subjectById(sid);
  if (!state.slots[key]) {
    state.slots[key] = sid;
    if (s && s.splitTeachers && teacherId) state.slotTeachers[key] = teacherId;
  }
  let linked = 0;
  if (s && s.splitTeachers) return linked; // 分節上課不走協同同步（各師各上不同節）
  const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
  if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid).forEach(p => {
    const g = classGrade(p); const mk = slotKey(p.id, day, period);
    if (g && gradePeriodHasDay(g, period, dNum) && !state.slots[mk]) { state.slots[mk] = sid; linked++; }
  });
  return linked;
}

/* ---------- 通用自動排課引擎（選用）：靜態緊度排序 + 貪婪 MRV，尊重所有硬約束 ---------- */
// 某 (day,period) 上所有已排格的授課指派（供增量衝堂檢查；可忽略某 key）
function assignmentsAtDP(day, period, ignoreKey) {
  const out = [];
  for (const key in state.slots) {
    if (key === ignoreKey) continue;
    const parts = key.split('|');
    if (parseInt(parts[1], 10) !== day || parts[2] !== period) continue;
    const sid = state.slots[key];
    slotAssignments(key).forEach(x => out.push({ classId: parts[0], subjectId: sid, teacherId: x.teacherId, roomId: x.roomId }));
  }
  return out;
}
const isMorningPeriod = pid => { const p = byId(state.settings.periods, pid); return p ? (p.start || '') < '12:00' : false; };
// v09.13 該格是否為該班該日「最後一節有課的節次」（第七節排輕科用；末節依各年級節次表動態判定）
function isLastPeriodOfDay(classId, day, period) {
  const g = classGrade(classById(classId)); if (!g) return false;
  const lessons = lessonPeriods(); const i = lessons.findIndex(p => p.id === period); if (i < 0) return false;
  for (let j = i + 1; j < lessons.length; j++) if (gradePeriodHasDay(g, lessons[j].id, parseInt(day, 10))) return false;
  return true;
}
// 教師單日節數上限（0＝不限）：個別覆寫優先、否則用全域
function teacherDailyCap(teacherId) { const t = teacherById(teacherId); const per = t && t.maxPerDay ? t.maxPerDay : 0; return per > 0 ? per : (state.settings.maxLessonsPerDay || 0); }
// 該師某日已排的節數（不列入上限的科目不計；以不同節次去重，協同同節只算一次）
function teacherDayLoad(teacherId, day) {
  const set = new Set();
  for (const key in state.slots) { const parts = key.split('|'); if (parseInt(parts[1], 10) !== day) continue; const s = subjectById(state.slots[key]); if (s && s.excludeDailyCap) continue; slotAssignments(key).forEach(x => { if (x.teacherId === teacherId) set.add(parts[2]); }); }
  return set.size;
}
// 這一格能否合法排入該科(該師)：格開放且空、符合科目日/節限制、老師不排課、無教師/教室衝堂、進階硬約束
function canPlaceAt(classId, day, period, sid, teacherId) {
  day = parseInt(day, 10); // 正規化：格子鍵傳入是字串，年級 periodDays/lockDays 存數字，需一致
  const key = slotKey(classId, day, period);
  if (state.slots[key]) return false;
  const c = classById(classId); const g = classGrade(c);
  if (!g || !gradePeriodHasDay(g, period, day)) return false;
  const s = subjectById(sid); if (!s) return false;
  if ((s.lockDays || []).length && !s.lockDays.includes(day)) return false;
  if ((s.lockPeriods || []).length && !s.lockPeriods.includes(period)) return false;
  const news = [];
  if (s.splitTeachers) {
    const L = loadsForClassSubject(classId, sid).find(x => x.teacher.id === teacherId);
    news.push({ teacherId, roomId: L ? (L.roomId || '') : '' });
  } else {
    loadsForClassSubject(classId, sid).forEach(x => news.push({ teacherId: x.teacher.id, roomId: x.roomId || '' }));
  }
  if (!news.length) return false; // 未配課，無法決定老師
  const dayStr = String(day);
  for (const a of news) { const t = teacherById(a.teacherId); if (t && (t.unavailable || []).includes(dayStr + '|' + period)) return false; }
  const existing = assignmentsAtDP(day, period, key);
  for (const e of existing) for (const a of news) {
    const coTogether = e.subjectId === sid && e.classId !== classId && classesCoteachTogether(e.classId, classId, sid);
    if (a.teacherId && a.teacherId === e.teacherId && !coTogether) return false;
    if (a.roomId && a.roomId === e.roomId) {
      const sameOffering = e.classId === classId && e.subjectId === sid;
      if (!sameOffering && !coTogether) return false;
    }
  }
  // 進階硬約束（連堂科目不套用分散/隔天：連堂本就同日兩節）
  if (!s.consecutive && (s.gapDays || s.distinctDays)) {
    for (const k in state.slots) { if (state.slots[k] !== sid) continue; const kp = k.split('|'); if (kp[0] !== classId) continue; const ud = parseInt(kp[1], 10);
      if (s.gapDays) { if (Math.abs(ud - day) < 2) return false; } else if (ud === day) return false; }
  }
  // v12.06 連堂剩餘單堂「完全不與連堂對同天」（硬約束）：此類科目每班同一天最多 2 節（＝一組連堂對），
  // 故第 3 節（剩餘單堂）一定落到別天，連堂對本身（同日相鄰兩節）不受影響。
  if (s.consecutive && s.singleApartFromPair) {
    let onDay = 0;
    for (const k in state.slots) { if (state.slots[k] !== sid) continue; const kp = k.split('|'); if (kp[0] === classId && parseInt(kp[1], 10) === day) onDay++; }
    if (onDay >= 2) return false;
  }
  // 教師單日節數上限
  if (!s.excludeDailyCap) {
    for (const a of news) { const cap = teacherDailyCap(a.teacherId); if (cap > 0 && teacherDayLoad(a.teacherId, day) + 1 > cap) return false; }
  }
  return true;
}
function candidateCells(classId, sid, teacherId) {
  const cells = [];
  for (const d of activeDays()) for (const p of lessonPeriods()) if (canPlaceAt(classId, d, p.id, sid, teacherId)) cells.push({ day: d, period: p.id });
  return cells;
}
// 給連堂科目找相鄰合法配對格（沿用合法連堂相鄰定義）
function adjacentLegalCell(classId, sid, teacherId, day, period) {
  const g = classGrade(classById(classId)); if (!g) return null;
  for (const dir of [1, -1]) {
    const nb = adjacentOpenPeriod(g, period, day, dir);
    if (nb && canPlaceAt(classId, day, nb, sid, teacherId)) return { day, period: nb };
  }
  return null;
}
// 靜態緊度：不看占用，只算該科在該班「日限制×節限制×開放格」的可用格數，越少越先排
function staticLooseness(classId, sid) {
  const c = classById(classId); const g = classGrade(c); if (!g) return 0;
  const s = subjectById(sid); let n = 0;
  for (const d of activeDays()) {
    if ((s.lockDays || []).length && !s.lockDays.includes(d)) continue;
    for (const p of lessonPeriods()) {
      if ((s.lockPeriods || []).length && !s.lockPeriods.includes(p.id)) continue;
      if (gradePeriodHasDay(g, p.id, d)) n++;
    }
  }
  return n;
}
// v11 自動排課「科目優先權分層」：越受限越先排、導師教本班的課最後
//  1 有排課限制 ▸ 2 有自動排課偏好 ▸ 3 需協同 ▸ 4 科任（含級任教其他班）▸ 5 級任教本班
function unitPriorityRank(classId, sid, teacherId) {
  const s = subjectById(sid); if (!s) return 4;
  if ((s.lockDays || []).length || (s.lockPeriods || []).length) return 1;
  if (s.preferBand || (s.preferPeriods || []).length || s.avoidLastPeriod || s.singleApartFromPair || s.gapDays || s.distinctDays) return 2;
  const c = classById(classId); if (c && c.coteach && c.coteach[sid]) return 3;
  const hr = homeroomTeacher(classId);
  if (hr) { const tids = s.splitTeachers ? [teacherId] : loadsForClassSubject(classId, sid).map(x => x.teacher.id); if (tids.includes(hr.id)) return 5; }
  return 4;
}
// 分階段排課的「階段」分類（v12.04）：1＝硬性規定課（有 lockDays/lockPeriods，如母語）；3＝級任導師教「本班」的課（多為主科）；2＝其餘（科任＋級任教他班＋協同）。
// 注意：與 unitPriorityRank 不同——主科雖有軟性偏好(rank 2)，但只要是級任教本班就屬階段 3（依使用者分階段心智模型）。
function unitStage(classId, sid, teacherId) {
  const s = subjectById(sid); if (!s) return 2;
  if ((s.lockDays || []).length || (s.lockPeriods || []).length) return 1;
  const hr = homeroomTeacher(classId);
  if (hr) { const tids = s.splitTeachers ? [teacherId] : loadsForClassSubject(classId, sid).map(x => x.teacher.id); if (tids.includes(hr.id)) return 3; }
  return 2;
}
function cellStage(key) {
  const sid = state.slots[key]; const cId = key.split('|')[0]; const s = subjectById(sid);
  const tid = s && s.splitTeachers ? (state.slotTeachers[key] || null) : null;
  return unitStage(cId, sid, tid);
}
// 建置待排單元（每單元＝一節課）；協同科目只由一個 leader 班代表（placeSubject 會同步夥伴班）
function buildAutoUnits() {
  const units = []; const seenCoteach = new Set();
  state.classes.forEach(c => {
    classSubjectHours(c).forEach(sh => {
      const sid = sh.subjectId; const s = subjectById(sid); if (!s) return;
      const gid = c.coteach && c.coteach[sid];
      if (gid) { const gk = sid + '#' + gid; if (seenCoteach.has(gk)) return; seenCoteach.add(gk); }
      const loose = staticLooseness(c.id, sid);
      if (s.splitTeachers) {
        loadsForClassSubject(c.id, sid).forEach(L => {
          const need = L.hours - placedByTeacher(c.id, sid, L.teacher.id);
          const rank = unitPriorityRank(c.id, sid, L.teacher.id);
          for (let i = 0; i < need; i++) units.push({ classId: c.id, sid, teacherId: L.teacher.id, consec: !!s.consecutive, loose, rank });
        });
      } else {
        const need = sh.hours - subjectPlaced(c.id, sid);
        const rank = unitPriorityRank(c.id, sid, null);
        for (let i = 0; i < need; i++) units.push({ classId: c.id, sid, teacherId: null, consec: !!s.consecutive, loose, rank });
      }
    });
  });
  // 優先權分層先 → 同層緊度小的先 → 同緊度連堂先
  units.sort((a, b) => (a.rank - b.rank) || (a.loose - b.loose) || (b.consec - a.consec));
  return units;
}
// 單格軟性評分（越低越好）：偏好時段、同科分散不同天、教師每日平衡、上午避免湊滿
function cellSoftScore(classId, day, period, sid, teacherId) {
  const s = subjectById(sid); let sc = 0;
  if (s.preferBand === 'am' && !isMorningPeriod(period)) sc += 4;
  if (s.preferBand === 'pm' && isMorningPeriod(period)) sc += 4;
  if ((s.preferPeriods || []).length && !s.preferPeriods.includes(period)) sc += 4;   // v09.13 偏好指定節
  if (s.avoidLastPeriod && isLastPeriodOfDay(classId, day, period)) sc += 5;            // v09.13 主科避末節（第七節排輕科）
  // v09.13 連堂剩餘單堂與連堂不同天：放同科已有課的當天再多一節→加罰（引導單堂另擇一天）
  // v12.01 連堂剩餘單堂不與連堂對相鄰天：同科已有課的同天或相鄰天(Δ≤1)再放一節→加罰（引導單堂離連堂對更遠）
  if (s.consecutive && s.singleApartFromPair) { for (const key in state.slots) { if (state.slots[key] === sid) { const p = key.split('|'); if (p[0] === classId && Math.abs(parseInt(p[1], 10) - day) <= 1) { sc += 3; break; } } } }
  if (!s.consecutive) { for (const key in state.slots) { if (state.slots[key] === sid) { const p = key.split('|'); if (p[0] === classId && parseInt(p[1], 10) === day) { sc += 3; break; } } } }
  const tids = s.splitTeachers ? [teacherId] : loadsForClassSubject(classId, sid).map(x => x.teacher.id);
  tids.forEach(tid => { if (tid) sc += teacherDayLoad(tid, day) * 0.5; });
  if (isMorningPeriod(period)) tids.forEach(tid => { if (!tid) return; let am = 0; for (const key in state.slots) { const p = key.split('|'); if (parseInt(p[1], 10) === day && isMorningPeriod(p[2])) slotAssignments(key).forEach(x => { if (x.teacherId === tid) am++; }); } if (am >= 3) sc += 2; });
  // R11 引導：級任本班課，盡量讓導師當天上午/下午都有課——放在「已覆蓋的半天」而另一半天還空→加罰，鼓勵先補另一半
  const hr = homeroomTeacher(classId);
  if (hr && tids.includes(hr.id)) {
    const inAm = isMorningPeriod(period); let hasAm = false, hasPm = false;
    for (const key in state.slots) { const p = key.split('|'); if (parseInt(p[1], 10) !== day) continue; slotAssignments(key).forEach(x => { if (x.teacherId === hr.id) { if (isMorningPeriod(p[2])) hasAm = true; else hasPm = true; } }); }
    if (inAm && hasAm && !hasPm) sc += 2;
    if (!inAm && hasPm && !hasAm) sc += 2;
  }
  return sc;
}
// 整體方案軟性罰分（越低越好）：教師每日節數離散、上午滿堂、偏好時段、同科同日重複
function scoreSolution() {
  let pen = 0; const perTD = {};
  for (const key in state.slots) { const p = key.split('|'); const d = parseInt(p[1], 10); slotAssignments(key).forEach(x => { if (!x.teacherId) return; (perTD[x.teacherId] = perTD[x.teacherId] || {}); (perTD[x.teacherId][d] = perTD[x.teacherId][d] || new Set()).add(p[2]); }); }
  for (const tid in perTD) { const dd = perTD[tid]; const sizes = Object.values(dd).map(s => s.size); if (sizes.length) pen += Math.max(...sizes) - Math.min(...sizes);
    for (const d in dd) { let am = 0; dd[d].forEach(pid => { if (isMorningPeriod(pid)) am++; }); if (am >= 4) pen += 2; } }
  // R11（既定機制，軟性）：級任導師每個「有課的上課日」上午/下午各至少 1 節；某半天該年級無節次或該師整個半天被不排課擋掉時豁免。
  { const { am, pm } = amPmPeriods(); const amSet = new Set(am), pmSet = new Set(pm);
    state.teachers.forEach(t => {
      if (!t.homeroomClassId) return; const c = classById(t.homeroomClassId); const g = c && classGrade(c); if (!g) return;
      const dd = perTD[t.id]; if (!dd) return; const un = t.unavailable || [];
      for (const dStr in dd) { const day = +dStr; const used = dd[day];
        const amReq = am.some(pid => gradePeriodHasDay(g, pid, day) && !un.includes(day + '|' + pid));   // 該師該日上午可上課→需有課
        const pmReq = pm.some(pid => gradePeriodHasDay(g, pid, day) && !un.includes(day + '|' + pid));
        if (amReq && ![...used].some(pid => amSet.has(pid))) pen += 3;
        if (pmReq && ![...used].some(pid => pmSet.has(pid))) pen += 3;
      }
    });
  }
  const seen = {};
  for (const key in state.slots) { const sid = state.slots[key]; const s = subjectById(sid); const p = key.split('|');
    if (s.preferBand === 'am' && !isMorningPeriod(p[2])) pen += 1;
    if (s.preferBand === 'pm' && isMorningPeriod(p[2])) pen += 1;
    if ((s.preferPeriods || []).length && !s.preferPeriods.includes(p[2])) pen += 1;                       // v09.13 偏好指定節
    if (s.avoidLastPeriod && isLastPeriodOfDay(p[0], p[1], p[2])) pen += 2;                                 // v09.13 主科避末節
    if (!s.consecutive) { const k = p[0] + '|' + sid + '|' + p[1]; seen[k] = (seen[k] || 0) + 1; } }
  for (const k in seen) if (seen[k] > 1) pen += (seen[k] - 1);
  // v09.13 連堂剩餘單堂與連堂不同天：某(班,科)若同一天同時有「已成對的連堂格」與「未成對的單堂格」，罰分
  const cg = {};
  for (const key in state.slots) { const sid = state.slots[key]; const s = subjectById(sid); if (!s || !s.consecutive || !s.singleApartFromPair) continue; const p = key.split('|'); (cg[p[0] + '|' + sid] = cg[p[0] + '|' + sid] || []).push({ day: parseInt(p[1], 10), period: p[2], classId: p[0], sid }); }
  for (const gk in cg) { const cells = cg[gk]; const classId = cells[0].classId; const sid = cells[0].sid; const g = classGrade(classById(classId)); if (!g) continue;
    cells.forEach(c => {
      const prev = adjacentOpenPeriod(g, c.period, c.day, -1), next = adjacentOpenPeriod(g, c.period, c.day, +1);
      c.paired = (prev && state.slots[slotKey(classId, c.day, prev)] === sid) || (next && state.slots[slotKey(classId, c.day, next)] === sid);
    });
    // v12.01 單堂不與連堂對相鄰天：連堂對所在天的同天或相鄰天(Δ≤1)有未成對單堂→罰
    const pairDays = [...new Set(cells.filter(c => c.paired).map(c => c.day))];
    cells.forEach(c => { if (!c.paired && pairDays.some(pd => Math.abs(pd - c.day) <= 1)) pen += 2; });
  }
  return pen;
}
// 一趟貪婪填課（靜態緊度序 + 軟分挑格 + 隨機抖動）；直接寫入 state.slots
function greedyRun(units, rnd) {
  const unplaced = []; let guard = 0; const pairsDone = {};   // v09.13 每(班|科|師)已成對數，尊重「連堂次數」上限（修奇數連堂溢排）
  while (units.length && guard++ < 20000) {
    const u = units.shift();
    let cands = candidateCells(u.classId, u.sid, u.teacherId);
    if (!cands.length) { unplaced.push(u); continue; }
    const gkey = u.classId + '|' + u.sid + '|' + (u.teacherId || '');
    let wantPair = false;                                     // 這節是否還要成連堂對（已達連堂次數就當單堂排）
    if (u.consec) {
      const s = subjectById(u.sid);
      const N = s.splitTeachers ? ((loadsForClassSubject(u.classId, u.sid).find(x => x.teacher.id === u.teacherId) || {}).hours || 0) : classSubjectRequired(u.classId, u.sid);
      wantPair = (pairsDone[gkey] || 0) < consecutiveTarget(u.sid, N);
      // v12.06 連堂剩餘單堂「不相鄰天」（半硬性偏好）：同天已由 canPlaceAt 硬性擋掉（候選皆為別天），
      //   這裡再優先只在「離所有已排天 ≥2 天（不相鄰）」的格挑；沒有這種格才退用相鄰別天。
      if (!wantPair && s.singleApartFromPair) {
        const placedDays = new Set();
        for (const key in state.slots) { if (state.slots[key] === u.sid) { const p = key.split('|'); if (p[0] === u.classId) placedDays.add(parseInt(p[1], 10)); } }
        if (placedDays.size) { const pd = [...placedDays]; const far = cands.filter(c => !pd.some(d => Math.abs(d - c.day) <= 1)); if (far.length) cands = far; }
      }
    }
    let best = null, bestScore = Infinity, bestPartner = null;
    for (const cell of cands) {
      let sc = cellSoftScore(u.classId, cell.day, cell.period, u.sid, u.teacherId) + rnd() * 0.9;
      let partner = null;
      if (wantPair) { partner = adjacentLegalCell(u.classId, u.sid, u.teacherId, cell.day, cell.period); if (!partner) sc += 5; }
      if (sc < bestScore) { bestScore = sc; best = cell; bestPartner = partner; }
    }
    placeSubject(u.classId, String(best.day), best.period, u.sid, u.teacherId);
    if (wantPair && bestPartner) {
      placeSubject(u.classId, String(bestPartner.day), bestPartner.period, u.sid, u.teacherId);
      pairsDone[gkey] = (pairsDone[gkey] || 0) + 1;
      const j = units.findIndex(x => x.classId === u.classId && x.sid === u.sid && x.teacherId === u.teacherId);
      if (j >= 0) units.splice(j, 1);
    }
  }
  return unplaced;
}
// 某協同課格的整個協同群組是否全在重排範圍內（否則不可清、以免拆散凍結的夥伴班）
function coteachFullyInScope(key, scopeSet) {
  const sid = state.slots[key]; const cId = key.split('|')[0]; const c = classById(cId);
  const gid = c && c.coteach && c.coteach[sid]; if (!gid) return true;
  return state.classes.filter(x => x.coteach && x.coteach[sid] === gid).every(x => scopeSet.has(x.id));
}
/* ==========================================================================
   更強求解（v12.02）＝連鎖修復（回溯）升級 + LNS 局部搜尋（ruin & recreate）
   —— 隨機重啟貪婪之後仍排不下時啟動：先以既有遞迴連鎖核心把排不下者（含連堂對/協同）
      塞入，再以「毀壞單純層 K 格→貪婪重建」的大鄰域搜尋逃離貪婪局部最佳。
   保底：全程只接受「不變差」的解（placed 單調不減、同 placed 取較低罰分），永不回退。
   安全：LNS 有時間預算與迭代上限，不會無限凍住瀏覽器。
   ========================================================================== */
// 分階段排課：增強階段（連鎖修復/LNS）也只處理「當前階段」的單元/格（null＝不限）
let autoStage = null;
// 目前 grid 下（scope 內、且屬當前階段）還差幾節未排 → 產生待排 units（沿用 buildAutoUnits 的 need＝應排−已排）
function residualUnitsScoped(scopeSet) {
  let units = buildAutoUnits();
  if (scopeSet) units = units.filter(u => scopeSet.has(u.classId));
  if (autoStage) units = units.filter(u => unitStage(u.classId, u.sid, u.teacherId) === autoStage);
  return units;
}
function residualCountScoped(scopeSet) { return residualUnitsScoped(scopeSet).reduce((n) => n + 1, 0); }
// 隨機「毀壞」單純層 K 格（只動單純科，保連堂/協同/分節完整；scope 內、當前階段內、非硬鎖）；回實際移除數
function ruinSimpleCells(scopeSet, k, rnd) {
  const keys = [];
  for (const key in state.slots) { const cId = key.split('|')[0]; if (scopeSet && !scopeSet.has(cId)) continue; if (autoHardLocked && autoHardLocked.has(key)) continue; if (autoStage && cellStage(key) !== autoStage) continue; if (isSimpleSubject(state.slots[key], cId)) keys.push(key); }
  for (let i = keys.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = keys[i]; keys[i] = keys[j]; keys[j] = t; }
  const rm = keys.slice(0, Math.min(k, keys.length));
  rm.forEach(key => { delete state.slots[key]; delete state.slotTeachers[key]; });
  return rm.length;
}
// 「重建」：把單純層的殘餘需求（含剛毀壞的）以貪婪＋隨機抖動重排入 grid（不動連堂/協同/分節；分階段時只重建當前階段）
function recreateSimple(scopeSet, rnd) {
  let units = buildAutoUnits().filter(u => isSimpleSubject(u.sid, u.classId));
  if (scopeSet) units = units.filter(u => scopeSet.has(u.classId));
  if (autoStage) units = units.filter(u => unitStage(u.classId, u.sid, u.teacherId) === autoStage);
  units.forEach(u => (u._r = rnd()));
  units.sort((a, b) => (a.rank - b.rank) || (a.loose - b.loose) || (a._r - b._r));
  greedyRun(units, rnd);
}
// R11 針對性修復：把級任導師「某上課日有一半天無課、另半天卻有剩(≥2節)」的一節單純本班課，搬到缺的半天空格。
// 只搬單純科(無連堂/協同/分節顧慮)、canPlaceAt 保證零衝堂、尊重硬鎖；每(師,日)最多修一處。回修復數。
function repairR11(scopeSet) {
  const { am, pm } = amPmPeriods(); const amSet = new Set(am), pmSet = new Set(pm); let fixed = 0;
  const tryMove = (cId, day, g, fromCells, toHalf) => {
    if (fromCells.length < 2) return false;
    for (const src of fromCells) {
      if (autoHardLocked && autoHardLocked.has(src.key)) continue;
      for (const pid of toHalf) {
        if (!gradePeriodHasDay(g, pid, day)) continue;
        const tk = slotKey(cId, day, pid); if (state.slots[tk]) continue;
        const snap = snapshotGrid();
        delete state.slots[src.key]; delete state.slotTeachers[src.key];
        if (canPlaceAt(cId, day, pid, src.sid, null)) { placeSubject(cId, String(day), pid, src.sid, null); return true; }
        restoreGrid(snap);
      }
    }
    return false;
  };
  for (const t of state.teachers) {
    if (!t.homeroomClassId) continue; const cId = t.homeroomClassId; if (scopeSet && !scopeSet.has(cId)) continue;
    const g = classGrade(classById(cId)); if (!g) continue; const un = t.unavailable || [];
    for (const day of activeDays()) {
      const mine = [];
      for (const key in state.slots) { const p = key.split('|'); if (p[0] !== cId || +p[1] !== day) continue; const sid = state.slots[key]; if (!isSimpleSubject(sid, cId)) continue; if (!loadsForClassSubject(cId, sid).some(x => x.teacher.id === t.id)) continue; mine.push({ key, sid, am: amSet.has(p[2]) }); }
      if (!mine.length) continue;
      const amCells = mine.filter(c => c.am), pmCells = mine.filter(c => !c.am);
      const amReq = am.some(pid => gradePeriodHasDay(g, pid, day) && !un.includes(day + '|' + pid));
      const pmReq = pm.some(pid => gradePeriodHasDay(g, pid, day) && !un.includes(day + '|' + pid));
      if (pmReq && !pmCells.length && amCells.length >= 2) { if (tryMove(cId, day, g, amCells, pm)) fixed++; }
      else if (amReq && !amCells.length && pmCells.length >= 2) { if (tryMove(cId, day, g, pmCells, am)) fixed++; }
    }
  }
  return fixed;
}
// LNS 大鄰域局部搜尋：ruin&recreate 單純層，單調接受（不變差），逃離貪婪局部最佳。回統計。
function strongSolveLNS(scopeSet, deadline, rnd) {
  let curSlots = { ...state.slots }, curST = { ...state.slotTeachers };
  let curPlaced = Object.keys(curSlots).length, curPen = scoreSolution();
  const simpleCount = Object.keys(curSlots).filter(key => { const cId = key.split('|')[0]; return (!scopeSet || scopeSet.has(cId)) && isSimpleSubject(curSlots[key], cId); }).length;
  let iters = 0, accepts = 0, stag = 0;
  while (performance.now() < deadline && iters < 6000) {
    iters++;
    state.slots = { ...curSlots }; state.slotTeachers = { ...curST };
    const k = Math.min(simpleCount, 2 + ((rnd() * 4) | 0) + Math.min(6, stag));   // 停滯時擴大毀壞範圍以逃離
    if (k <= 0) break;
    ruinSimpleCells(scopeSet, k, rnd);
    recreateSimple(scopeSet, rnd);
    const placed = Object.keys(state.slots).length, pen = scoreSolution();
    if (placed > curPlaced || (placed === curPlaced && pen < curPen)) {
      curSlots = { ...state.slots }; curST = { ...state.slotTeachers }; curPlaced = placed; curPen = pen; accepts++; stag = 0;
      if (residualCountScoped(scopeSet) === 0) break;                             // 已全排滿，提早收工
    } else { stag++; }
  }
  state.slots = curSlots; state.slotTeachers = curST;
  return { iters, accepts };
}
// 連鎖修復（回溯）：對排不下者用遞迴連鎖調課塞入（含連堂對＋協同；奇數連堂剩單堂交給 greedy/LNS）。回仍排不下的 units。
// deadline＝時間截止（ms，performance.now 基準）：超時後剩餘的直接列為排不下，避免大規模長凍。
function finalChainRepair(scopeSet, maxDepth, deadline) {
  autoRelocScope = scopeSet;
  let units = residualUnitsScoped(scopeSet);
  units.sort((a, b) => (a.rank - b.rank) || (a.loose - b.loose) || (b.consec - a.consec));
  const still = []; const opts = { budgetN: 4000, deadline: deadline || 0 };
  for (const u of units) {
    const s = subjectById(u.sid); const spec = { classId: u.classId, sid: u.sid, teacherId: u.teacherId || null };
    const rem = specRemaining(spec);
    if (rem <= 0) continue;                                   // 已被其他修復填滿（同 spec 的重複 unit）
    if (deadline && performance.now() > deadline) { still.push(u); continue; }   // 超時：剩餘不再嘗試
    if (s && s.consecutive && rem < 2) { still.push(u); continue; }   // 連堂只成對搬入，奇數單堂除外
    if (!placeWithChain(spec, maxDepth, opts)) still.push(u);
  }
  autoRelocScope = null;
  return still;
}
// 隨機重啟求解：多趟貪婪，保留「排最多、其次罰分最低」的最佳解
//  scope＝null → 全校（clearFirst 決定清空重排或只補空格）；scope＝班級id陣列 → 只重排這些班、其餘凍結
function runAutoSchedule(clearFirst, scope, opts) {
  opts = opts || {};
  const stage = opts.stage || null;                            // 分階段模式：1硬限制/2科任/3級任本班
  const scopeSet = (scope && scope.length) ? new Set(scope) : null;
  autoHardLocked = null; autoStage = stage;
  let baseSlots, baseST;
  if (stage) {
    // 分階段：凍結「別階段」與「範圍外」全部；只清「當前階段且在範圍內」的格重排。階段1的格對階段2/3一律硬鎖（不得被連鎖/LNS 搬動）。
    baseSlots = {}; baseST = {}; const hard = new Set();
    for (const k in state.slots) {
      const cs = cellStage(k);
      if (cs === 1 && stage !== 1) hard.add(k);
      const inScope = !scopeSet || scopeSet.has(k.split('|')[0]);
      if (cs !== stage || !inScope) { baseSlots[k] = state.slots[k]; if (state.slotTeachers[k]) baseST[k] = state.slotTeachers[k]; }
    }
    if (stage !== 1) autoHardLocked = hard;
  } else if (scopeSet) {
    // 凍結範圍外全部；範圍內「可清的格」（非跨範圍協同）清掉重排
    baseSlots = {}; baseST = {};
    for (const k in state.slots) {
      const clearable = scopeSet.has(k.split('|')[0]) && coteachFullyInScope(k, scopeSet);
      if (!clearable) { baseSlots[k] = state.slots[k]; if (state.slotTeachers[k]) baseST[k] = state.slotTeachers[k]; }
    }
  } else {
    if (opts.hardLockStage1) autoHardLocked = new Set(Object.keys(state.slots).filter(k => cellStage(k) === 1));   // 補完階段：階段1仍硬鎖不動
    baseSlots = clearFirst ? {} : { ...state.slots };
    baseST = clearFirst ? {} : { ...state.slotTeachers };
  }
  let seed = 20260804; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let best = null, runs = 0; const t0 = performance.now(); const BUDGET = 2500; const STRONG_BUDGET = 4000;   // 更強求解（連鎖修復＋LNS）總時間上限；僅在仍排不下時才用，避免瀏覽器長凍
  do {
    state.slots = { ...baseSlots }; state.slotTeachers = { ...baseST };
    let units = buildAutoUnits();
    if (scopeSet) units = units.filter(u => scopeSet.has(u.classId));   // 局部重排：只排範圍內班級的單元
    if (stage) units = units.filter(u => unitStage(u.classId, u.sid, u.teacherId) === stage);   // 分階段：只排當前階段科目
    units.forEach(u => (u._r = rnd()));
    units.sort((a, b) => (a.rank - b.rank) || (a.loose - b.loose) || (b.consec - a.consec) || (a._r - b._r));
    const unplaced = greedyRun(units, rnd);
    const placed = Object.keys(state.slots).length; const penalty = scoreSolution();
    const key = placed * 100000 - penalty;
    if (!best || key > best.key) best = { key, slots: { ...state.slots }, slotTeachers: { ...state.slotTeachers }, unplaced, placed, penalty };
    runs++;
  } while (performance.now() - t0 < BUDGET && runs < 300);
  state.slots = best.slots; state.slotTeachers = best.slotTeachers;
  const beforeRepair = best.unplaced.length;
  // ── 更強求解階段（各子階段有明確時間截止，總計 ≤ STRONG_BUDGET；僅在仍排不下時才付出成本）──
  let strong = null;
  // 階段①「連鎖修復（回溯）」＝主力：遞迴連鎖調課把排不下者（含連堂對/協同）塞入。
  let stillUnplaced = finalChainRepair(scopeSet, 4, performance.now() + STRONG_BUDGET * 0.55);
  // 階段②「LNS 局部搜尋」：仍排不下→毀壞單純層再貪婪重建以逃離貪婪局部最佳；再做一次短連鎖修復收尾。
  if (stillUnplaced.length) {
    let seed2 = (seed ^ 0x5bd1e995) & 0x7fffffff; const rnd2 = () => { seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff; return seed2 / 0x7fffffff; };
    strong = strongSolveLNS(scopeSet, performance.now() + STRONG_BUDGET * 0.30, rnd2);
    stillUnplaced = finalChainRepair(scopeSet, 4, performance.now() + STRONG_BUDGET * 0.15);
  }
  repairR11(scopeSet);   // R11：把級任缺半天者的一節單純課搬到缺的半天（零衝堂、尊重硬鎖）
  autoHardLocked = null; autoStage = null;   // 清除分階段狀態，避免影響後續互動式喬課
  save();
  return { unplaced: stillUnplaced, runs, ms: Math.round(performance.now() - t0), penalty: scoreSolution(), repaired: beforeRepair - stillUnplaced.length, beforeRepair, strong };
}
function autoScheduleModal() {
  if (state.lockFinalized) { toast('課表已鎖定，請先解除鎖定再自動排課'); return; }
  const problems = checkStaffing();
  if (problems.length) { toast('尚有配課問題，請先在「③ 教師」把各班每科節數配齊'); return; }
  const clsChecks = state.classes.map(c => `<label class="checkbox" style="margin-right:14px;white-space:nowrap"><input type="checkbox" class="auto-scope-cls" value="${c.id}"> ${esc(c.name)}</label>`).join('');
  openModal({
    title: '🪄 自動排課',
    body: `<p style="margin-top:0">依科目的教學型態與排課限制、教師配課、不排課時段與教師單日上限，自動把每科排滿，並避開教師/教室衝堂；排不下者會嘗試<b>連鎖調課</b>挪出空間。多次嘗試取較佳解。</p>
      <p style="color:var(--muted);font-size:13px">輔助工具：能排的先排滿，排不下的會列出讓你手動處理；排完仍可自由微調。</p>
      <div class="card" style="margin-top:8px"><div class="card-body">
        <label class="checkbox" style="display:block;margin-bottom:6px"><input type="radio" name="autoScope" value="all" checked> <b>全校</b></label>
        <label class="checkbox" style="display:block;margin:0 0 12px 22px"><input type="checkbox" id="autoClear" checked> 清空現有排課，全部重排（取消則只補空格、保留已排）</label>
        <label class="checkbox" style="display:block;margin-bottom:6px"><input type="radio" name="autoScope" value="classes"> <b>只重排指定班級</b>（其餘班級<b>凍結不動</b>；勾選的班級會先清空再重排）</label>
        <div style="margin-left:22px;display:flex;flex-wrap:wrap;gap:2px 0">${clsChecks || '<span style="color:var(--muted)">尚無班級</span>'}</div>
      </div></div>
      <div style="margin-top:10px;padding:10px 12px;border:1px dashed var(--line,#cbd5e1);border-radius:8px;background:var(--panel,#f8fafc)">
        <div style="font-weight:700;margin-bottom:2px">🎚️ 想分階段排課？</div>
        <div style="color:var(--muted);font-size:13px;margin-bottom:8px">先排硬性規定課（母語）並鎖定，再排科任課，最後排級任本班主科——逐步檢視、逐步鎖定。</div>
        <button class="ghost" data-action="staged-schedule">改用分階段排課 →</button>
      </div>`,
    saveLabel: '開始排課',
    onSave: () => {
      const mode = (document.querySelector('input[name="autoScope"]:checked') || {}).value;
      let scope = null;
      if (mode === 'classes') {
        scope = [...document.querySelectorAll('.auto-scope-cls:checked')].map(el => el.value);
        if (!scope.length) { toast('請至少勾選一個要重排的班級'); return false; }
      }
      const clear = $('#autoClear').checked;
      pushUndo();
      const r = runAutoSchedule(clear, scope);
      render();
      setTimeout(() => autoResultModal(r.unplaced, r), 0); // 等 modal-save 關掉設定 modal 後再開結果 modal
      return true;
    },
  });
}
// 診斷某(班,科[,師])為何排不下：掃描所有「排課限制允許的格」，逐格找出第一個阻擋原因並統計，回一句可行動的說明。
// 阻擋原因優先序＝先報「硬阻礙」（教師不排課、教師單日上限、同科間隔限制——清空該格也沒用），再報「軟阻礙」（占用/衝堂——可手動挪課）。
function unplacedReason(spec) {
  const { classId, sid, teacherId } = spec;
  const s = subjectById(sid); const c = classById(classId); const g = classGrade(c);
  if (!s) return '';
  if (!g) return '班級未設定年級';
  let loads = loadsForClassSubject(classId, sid);
  if (teacherId) loads = loads.filter(x => x.teacher.id === teacherId);
  if (!loads.length) return '尚未配課（此科在本班無授課老師）';
  const DOW = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  const allowed = [];
  for (const d of activeDays()) {
    if ((s.lockDays || []).length && !s.lockDays.includes(d)) continue;
    for (const p of lessonPeriods()) {
      if ((s.lockPeriods || []).length && !s.lockPeriods.includes(p.id)) continue;
      if (gradePeriodHasDay(g, p.id, d)) allowed.push({ d, p: p.id });
    }
  }
  if (!allowed.length) return '排課限制（指定上課日/節次）與該年級課表無交集，沒有任何可用格→請放寬此科的日/節限制';
  const b = { unavail: 0, cap: 0, gap: 0, occupied: 0, tclash: 0, rclash: 0, free: 0 };
  let capName = '', capDay = 0, capN = 0, unavailName = '';
  for (const { d, p } of allowed) {
    const un = loads.find(L => (teacherById(L.teacher.id).unavailable || []).includes(d + '|' + p));
    if (un) { b.unavail++; unavailName = un.teacher.name; continue; }
    let capT = null;
    if (!s.excludeDailyCap) { for (const L of loads) { const cap = teacherDailyCap(L.teacher.id); if (cap > 0 && teacherDayLoad(L.teacher.id, d) + 1 > cap) { capT = { name: L.teacher.name, day: d, cap }; break; } } }
    if (capT) { b.cap++; capName = capT.name; capDay = capT.day; capN = capT.cap; continue; }
    let gapBad = false;
    if (!s.consecutive && (s.gapDays || s.distinctDays)) { for (const k in state.slots) { if (state.slots[k] !== sid) continue; const kp = k.split('|'); if (kp[0] !== classId) continue; const ud = parseInt(kp[1], 10); if (s.gapDays ? Math.abs(ud - d) < 2 : ud === d) { gapBad = true; break; } } }
    if (gapBad) { b.gap++; continue; }
    if (state.slots[slotKey(classId, d, p)]) { b.occupied++; continue; }
    const ex = assignmentsAtDP(d, p, slotKey(classId, d, p)); let tcl = false, rcl = false;
    for (const e of ex) for (const L of loads) { const co = e.subjectId === sid && e.classId !== classId && classesCoteachTogether(e.classId, classId, sid); if (L.teacher.id === e.teacherId && !co) tcl = true; if (L.roomId && L.roomId === e.roomId && !(e.classId === classId && e.subjectId === sid) && !co) rcl = true; }
    if (tcl) { b.tclash++; continue; }
    if (rcl) { b.rclash++; continue; }
    b.free++;
  }
  const N = allowed.length;
  // 硬阻礙佔滿所有可用格 → 直接點名
  if (b.cap > 0 && b.cap + b.unavail + b.gap >= N && b.cap >= b.gap) return `教師單日上限：${capName} 於${DOW[capDay]}已達單日上限（${capN} 節），此科又限定該日/節無法改天，故排不下→提高該師「單日上限」、放寬本科鎖定天、或改由其他老師分攤`;
  if (b.unavail >= N) return `教師不排課時段擋住所有可用格（${unavailName}）→請檢查該師的「不排課時段」設定`;
  if (b.gap > 0 && b.gap + b.occupied + b.tclash + b.rclash + b.cap >= N && b.free === 0 && b.gap >= Math.max(b.occupied, b.tclash, b.rclash)) return `同科間隔限制：此科設了「不同天／隔天」，可用的天都已排過→放寬此科的分散設定`;
  const parts = [];
  if (b.occupied) parts.push(`${b.occupied} 格已排其他課`);
  if (b.tclash) parts.push(`${b.tclash} 格老師在他班上課`);
  if (b.rclash) parts.push(`${b.rclash} 格教室被占用`);
  if (b.cap) parts.push(`${b.cap} 格達教師單日上限`);
  if (b.unavail) parts.push(`${b.unavail} 格教師不排課`);
  if (b.gap) parts.push(`${b.gap} 格受間隔限制`);
  if (!parts.length) return `可用格 ${N}，但求解未填入（可再按一次「只補空格」）`;
  return `可用格共 ${N}，皆被擋：` + parts.join('、') + '→可手動挪走占用課或放寬限制後再「只補空格」';
}
function autoResultModal(unplaced, r) {
  const total = Object.keys(state.slots).length;
  const conf = Object.keys(computeConflicts()).length;
  let body = `<div class="total-badge ${unplaced.length ? 'bad' : 'ok'}">${unplaced.length ? `⚠ 有 ${unplaced.length} 節排不下（其餘已排）` : '✓ 全部排滿'}　·　已排 ${total} 格　·　衝堂 ${conf}</div>
    <p style="color:var(--muted);font-size:12px;margin:6px 0 0">嘗試 ${r.runs} 種排法取最佳（品質分 ${r.penalty}，越低越好）·　${r.ms}ms${r.repaired ? `　·　🔧 連鎖修復＋更強求解再塞入 ${r.repaired} 節` : ''}${r.strong ? `　·　🧠 局部搜尋 ${r.strong.iters} 次（採用 ${r.strong.accepts}）` : ''}</p>`;
  if (unplaced.length) {
    const agg = {};
    unplaced.forEach(u => { const k = u.classId + '|' + u.sid + '|' + (u.teacherId || ''); agg[k] = agg[k] || { u, n: 0 }; agg[k].n++; });
    body += `<p style="color:var(--danger);font-weight:700;margin:12px 0 4px">排不下的課（下方「可能原因」逐項診斷，指出該調哪裡）：</p>
      <table class="data"><thead><tr><th>班級</th><th>科目</th><th>老師</th><th>缺</th><th style="text-align:left">可能原因</th></tr></thead><tbody>
      ${Object.values(agg).map(({ u, n }) => `<tr><td>${esc((classById(u.classId) || {}).name || '')}</td><td>${esc(subjectName(u.sid))}</td><td>${u.teacherId ? esc(teacherName(u.teacherId)) : '<span style="color:var(--muted)">—</span>'}</td><td style="font-weight:700">${n}</td><td style="text-align:left;font-size:12px;line-height:1.5;white-space:normal">${esc(unplacedReason({ classId: u.classId, sid: u.sid, teacherId: u.teacherId || null }))}</td></tr>`).join('')}
      </tbody></table>
      <p style="color:var(--muted);font-size:12px;margin-top:8px">「可能原因」以最關鍵的阻礙為主：<b>硬阻礙</b>（教師單日上限／不排課／科目日節限制）需調設定；<b>軟阻礙</b>（格被占用／衝堂）可手動挪課後再按「只補空格」。</p>`;
  }
  openModal({ title: '自動排課結果', wide: true, body });
}
/* ---------- 分階段排課（v12.04）：①硬限制→②科任→③級任本班→④補完；階段1硬鎖、階段2軟鎖 ---------- */
let stagedStatus = { 1: null, 2: null, 3: null, fin: null };
let stagedLast = null;   // 最近執行的階段（診斷表只顯示這一次的結果）
function stageLabel(s) { return s === 1 ? '① 排硬性規定課（母語等有排課限制）' : s === 2 ? '② 排科任課（含級任教其他班）' : s === 3 ? '③ 排級任本班課（多為主科）' : '④ 補完剩餘（單趟補空格，階段①仍鎖）'; }
function stagedScheduleModal() {
  if (state.lockFinalized) { toast('課表已鎖定，請先解除鎖定再排課'); return; }
  const problems = checkStaffing();
  if (problems.length) { toast('尚有配課問題，請先在「④ 教師」把各班每科節數配齊'); return; }
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const k in state.slots) counts[cellStage(k)]++;
  const stat = s => { const r = stagedStatus[s]; if (!r) return '<span style="color:var(--muted)">尚未執行</span>'; return r.unplaced.length ? `<span style="color:var(--danger);font-weight:700">⚠ ${r.unplaced.length} 節排不下</span>` : `<span style="color:#10b981;font-weight:700">✓ 完成</span>`; };
  let body = `<p style="margin-top:0">依你的流程逐階段排入，每階段排完可先看課表、手動微調，再排下一階段。<b>階段①硬鎖</b>（母語等定案後不再被動）、<b>階段②軟鎖</b>（排③時求解器可自動微調挪讓科任的單純課以騰出空間，母語不動）。</p>
    <div class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      ${[1, 2, 3].map(s => `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="btn" data-action="run-stage" data-stage="${s}" style="min-width:280px;text-align:left">${stageLabel(s)}</button>
        <span>${stat(s)}</span></div>`).join('')}
      <hr style="border:none;border-top:1px solid var(--line,#e5e7eb);margin:0">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="ghost" data-action="run-stage" data-stage="fin" style="min-width:280px;text-align:left">${stageLabel('fin')}</button>
        <span>${stat('fin')}</span></div>
    </div></div>
    <p style="color:var(--muted);font-size:12px;margin-top:8px">目前已排：階段① <b>${counts[1]}</b> 節、階段② <b>${counts[2]}</b> 節、階段③ <b>${counts[3]}</b> 節。分階段較好逐步檢視控制，但填滿率可能略低於「一次排全部」；剩少數排不下時用「④補完剩餘」或手動處理即可。每個階段都可重按（會清掉該階段重排、其餘階段保留）。</p>`;
  const lastFail = (stagedLast != null && stagedStatus[stagedLast] && stagedStatus[stagedLast].unplaced.length) ? stagedStatus[stagedLast] : null;
  if (lastFail) {
    const agg = {}; lastFail.unplaced.forEach(u => { const k = u.classId + '|' + u.sid + '|' + (u.teacherId || ''); agg[k] = agg[k] || { u, n: 0 }; agg[k].n++; });
    body += `<p style="color:var(--danger);font-weight:700;margin:12px 0 4px">最近一次排不下的課（可能原因）：</p>
      <table class="data"><thead><tr><th>班級</th><th>科目</th><th>缺</th><th style="text-align:left">可能原因</th></tr></thead><tbody>
      ${Object.values(agg).map(({ u, n }) => `<tr><td>${esc((classById(u.classId) || {}).name || '')}</td><td>${esc(subjectName(u.sid))}</td><td style="font-weight:700">${n}</td><td style="text-align:left;font-size:12px;white-space:normal">${esc(unplacedReason({ classId: u.classId, sid: u.sid, teacherId: u.teacherId || null }))}</td></tr>`).join('')}
      </tbody></table>`;
  }
  openModal({ title: '🎚️ 分階段排課', wide: true, body });
}
function runStage(stage) {
  pushUndo();
  const opts = stage === 'fin' ? { hardLockStage1: true } : { stage: +stage };
  const r = runAutoSchedule(false, null, opts);
  stagedStatus[stage] = { unplaced: r.unplaced, r }; stagedLast = stage;
  render();
  setTimeout(() => stagedScheduleModal(), 0);
}
/* ---------- 一鍵清空排課（v12.05）：全校或指定班級；已鎖定（一鍵/單格）的格不清 ---------- */
function clearSchedule(scopeSet) {
  pushUndo();
  let n = 0;
  for (const key of Object.keys(state.slots)) {
    if (scopeSet && !scopeSet.has(key.split('|')[0])) continue;
    if (cellIsLocked(key)) continue;                    // 保留已鎖定格（一鍵全鎖／單格鎖定）
    delete state.slots[key]; delete state.slotTeachers[key]; n++;
  }
  save();
  return n;
}
function clearScheduleModal() {
  if (lockMode) { toast('單格鎖定選取中，請先完成或取消鎖定'); return; }
  if (!Object.keys(state.slots).length) { toast('目前沒有已排的課'); return; }
  const lockedN = Object.keys(state.slots).filter(cellIsLocked).length;
  const clsChecks = state.classes.map(c => `<label class="checkbox" style="margin-right:14px;white-space:nowrap"><input type="checkbox" class="clear-scope-cls" value="${c.id}"> ${esc(c.name)}</label>`).join('');
  openModal({
    title: '🧹 清空排課',
    body: `<p style="margin-top:0">清除已排的課以便重排。<b>已鎖定的格（🔒一鍵鎖定／🎯單格鎖定）不會被清除</b>；科目偏好、配課、鎖定狀態一律保留。</p>
      ${lockedN ? `<p style="color:var(--muted);font-size:13px">目前有 <b>${lockedN}</b> 格已鎖定，將自動略過不清。</p>` : ''}
      <div class="card"><div class="card-body">
        <label class="checkbox" style="display:block;margin-bottom:8px"><input type="radio" name="clearScope" value="all" checked> <b>全校</b>（清空所有班級未鎖定的課）</label>
        <label class="checkbox" style="display:block;margin-bottom:6px"><input type="radio" name="clearScope" value="classes"> <b>指定班級</b></label>
        <div style="margin-left:22px;display:flex;flex-wrap:wrap;gap:2px 0">${clsChecks || '<span style="color:var(--muted)">尚無班級</span>'}</div>
      </div></div>
      <p style="color:var(--muted);font-size:12px;margin-top:8px">清空後若後悔，可按工具列「↶ 復原」救回。</p>`,
    saveLabel: '清空',
    onSave: () => {
      const mode = (document.querySelector('input[name="clearScope"]:checked') || {}).value;
      let scopeSet = null;
      if (mode === 'classes') {
        const sel = [...document.querySelectorAll('.clear-scope-cls:checked')].map(el => el.value);
        if (!sel.length) { toast('請至少勾選一個班級'); return false; }
        scopeSet = new Set(sel);
      }
      const n = clearSchedule(scopeSet);
      render();
      toast(n ? `已清空 ${n} 節（保留鎖定格）` : '沒有可清空的課（可能都已鎖定或不在範圍內）');
      return true;
    },
  });
}

/* ---------- 半自動排課建議（手排輔助）：空格建議 + 調課連鎖 ---------- */
const periodLabel = pid => (byId(state.settings.periods, pid) || {}).label || pid;
// 某(班,科[,師])還差幾節未排
function subjectRemaining(classId, sid, teacherId) {
  const s = subjectById(sid); if (!s) return 0;
  if (s.splitTeachers) { const L = loadsForClassSubject(classId, sid).find(x => x.teacher.id === teacherId); return L ? L.hours - placedByTeacher(classId, sid, teacherId) : 0; }
  return classSubjectRequired(classId, sid) - subjectPlaced(classId, sid);
}
// 該班所有開放格（不論空滿）
function openGridCells(classId) {
  const g = classGrade(classById(classId)); const out = []; if (!g) return out;
  for (const d of activeDays()) for (const p of lessonPeriods()) if (gradePeriodHasDay(g, p.id, d)) out.push({ day: d, period: p.id });
  return out;
}
// 「單純可調」科目：非分組/分節/連堂、該班非協同（調課連鎖只動這種，確保單格搬移不影響其他班）
function isSimpleSubject(sid, classId) {
  const s = subjectById(sid); if (!s) return false;
  if (s.allowGrouping || s.splitTeachers || s.consecutive) return false;
  const c = classById(classId); if (c && c.coteach && c.coteach[sid]) return false;
  return true;
}
// 這一格「可以放什麼」：該班尚缺、且合法可放的 (科,師)
function suggestionsForCell(classId, day, period) {
  const out = [];
  classSubjectHours(classById(classId)).forEach(sh => {
    const sid = sh.subjectId; const s = subjectById(sid); if (!s) return;
    if (s.splitTeachers) {
      loadsForClassSubject(classId, sid).forEach(L => {
        if (subjectRemaining(classId, sid, L.teacher.id) > 0 && canPlaceAt(classId, day, period, sid, L.teacher.id))
          out.push({ sid, teacherId: L.teacher.id, name: s.name, teacherLabel: L.teacher.name, color: s.color, split: true });
      });
    } else if (subjectRemaining(classId, sid, null) > 0 && canPlaceAt(classId, day, period, sid, null)) {
      out.push({ sid, teacherId: null, name: s.name, teacherLabel: subjectTeachersLabel(classId, sid), color: s.color });
    }
  });
  return out;
}
/* ==========================================================================
   共用移動搜尋核心（A 組增量 1）
   —— 把「一堂課」抽象成可移動單元，在假想 grid 上做約束檢查與多步（跨班）連鎖，
      供「喬課」與日後「調課（公布後請假限期對調）」共用。
   spec = { classId, sid, teacherId }（teacherId 僅分節有意義；其餘 null）。
   保證：所有落點皆過 canPlaceAt（硬約束），套用後不產生任何新衝堂。
   本增量：目標課可為任意型態（單純/分組/協同/分節/連堂）；被搬移的「占用課」僅限單純科（單格、屬自己班），
           但連鎖可跨班（因某格的阻礙常是老師/教室在別班被占用）。搬移非單純占用課留待後續增量。
   ========================================================================== */
function snapshotGrid() { return { slots: { ...state.slots }, slotTeachers: { ...state.slotTeachers } }; }
function restoreGrid(s) { state.slots = s.slots; state.slotTeachers = s.slotTeachers; }

// spec 在某格會用到的授課指派（老師/教室）
function specAssignmentsAt(spec, cellKey) {
  const cId = cellKey.split('|')[0]; const s = subjectById(spec.sid);
  if (s && s.splitTeachers) { const L = loadsForClassSubject(cId, spec.sid).find(x => x.teacher.id === spec.teacherId); return [{ teacherId: spec.teacherId, roomId: L ? (L.roomId || '') : '' }]; }
  return loadsForClassSubject(cId, spec.sid).map(x => ({ teacherId: x.teacher.id, roomId: x.roomId || '' }));
}
// 某(day,period) 目前所有已排格的授課（含 key，供辨識要搬哪一格）
function offeringsAtDP(day, period) {
  const out = [];
  for (const key in state.slots) { const p = key.split('|'); if (parseInt(p[1], 10) !== day || p[2] !== period) continue; slotAssignments(key).forEach(x => out.push({ key, classId: p[0], subjectId: state.slots[key], teacherId: x.teacherId, roomId: x.roomId })); }
  return out;
}
// spec 在該格的靜態可行性（不看占用/外部衝堂，那些是可搬阻礙）：日/節限制、老師不排課
function specStaticOK(spec, cellKey) {
  const [, dStr, period] = cellKey.split('|'); const day = parseInt(dStr, 10); const s = subjectById(spec.sid);
  if ((s.lockDays || []).length && !s.lockDays.includes(day)) return false;
  if ((s.lockPeriods || []).length && !s.lockPeriods.includes(period)) return false;
  for (const a of specAssignmentsAt(spec, cellKey)) { const t = teacherById(a.teacherId); if (t && (t.unavailable || []).includes(dStr + '|' + period)) return false; }
  return true;
}
// 列出 spec 的候選落點（依型態回不同結構的 cells）；avoid 內的格不用
function targetPlacements(spec, avoid) {
  const { classId, sid } = spec; const s = subjectById(sid); const c = classById(classId); const g = classGrade(c);
  if (!g) return [];
  const coteach = !!(c.coteach && c.coteach[sid]);
  const opens = openGridCells(classId).filter(x => !avoid.has(slotKey(classId, x.day, x.period)));
  const res = [];
  if (s.consecutive && coteach) return res;                       // 連堂＋協同組合，本增量不支援
  if (s.consecutive) {                                            // 連堂：相鄰兩格
    for (const x of opens) {
      const nb = adjacentOpenPeriod(g, x.period, x.day, +1); if (!nb) continue;
      const k1 = slotKey(classId, x.day, x.period), k2 = slotKey(classId, x.day, nb);
      if (avoid.has(k2)) continue;
      res.push({ kind: 'consec', cells: [k1, k2] });
    }
  } else if (coteach) {                                           // 協同：本班＋夥伴班同(day,period)
    const gid = c.coteach[sid];
    for (const x of opens) {
      const cells = [slotKey(classId, x.day, x.period)];
      state.classes.forEach(p => { if (p.id !== classId && p.coteach && p.coteach[sid] === gid) { const pg = classGrade(p); if (pg && gradePeriodHasDay(pg, x.period, x.day)) cells.push(slotKey(p.id, x.day, x.period)); } });
      res.push({ kind: 'coteach', cells });
    }
  } else {                                                        // 單純／分組／分節：單格
    for (const x of opens) res.push({ kind: 'single', cells: [slotKey(classId, x.day, x.period)] });
  }
  return res;
}
// 某落點的阻礙格集合（占用格＋外部師/室衝堂來源）；回 Set(keys)，或 null＝此落點不可行（格不可用／有非單純阻礙）
function blockersFor(placement, spec) {
  const blockers = new Set();
  for (const cell of placement.cells) {
    const [cId, dStr, period] = cell.split('|'); const day = parseInt(dStr, 10);
    const g = classGrade(classById(cId)); if (!g || !gradePeriodHasDay(g, period, day)) return null;
    if (!specStaticOK(spec, cell)) return null;
    if (state.slots[cell]) { if (!isSimpleSubject(state.slots[cell], cId)) return null; blockers.add(cell); }
    const news = specAssignmentsAt(spec, cell);
    for (const e of offeringsAtDP(day, period)) {
      if (placement.cells.includes(e.key)) continue;             // 自己的落點格（占用已另計）
      for (const a of news) {
        const coTogether = e.subjectId === spec.sid && e.classId !== cId && classesCoteachTogether(e.classId, cId, spec.sid);
        const teacherClash = a.teacherId && a.teacherId === e.teacherId && !coTogether;
        const roomClash = a.roomId && a.roomId === e.roomId && !(e.classId === cId && e.subjectId === spec.sid) && !coTogether;
        if (teacherClash || roomClash) { if (!isSimpleSubject(e.subjectId, e.classId)) return null; blockers.add(e.key); }
      }
    }
  }
  return blockers;
}
// 實際把 spec 放到落點（回傳成功與否；失敗會自清）；用 canPlaceAt 當最終硬約束閘門
function tentativePlaceSpec(spec, placement) {
  const s = subjectById(spec.sid);
  if (placement.kind === 'consec') {
    const [k1, k2] = placement.cells; const [c, d, p1] = k1.split('|'); const p2 = k2.split('|')[2];
    if (!canPlaceAt(c, d, p1, spec.sid, spec.teacherId)) return false;
    placeSubject(c, d, p1, spec.sid, spec.teacherId);
    if (!canPlaceAt(c, d, p2, spec.sid, spec.teacherId)) { delete state.slots[k1]; delete state.slotTeachers[k1]; return false; }
    placeSubject(c, d, p2, spec.sid, spec.teacherId);
    return true;
  }
  if (placement.kind === 'coteach') {
    for (const cell of placement.cells) { const [c, d, p] = cell.split('|'); if (!canPlaceAt(c, d, p, spec.sid, null)) return false; }
    const [lc, ld, lp] = placement.cells[0].split('|'); placeSubject(lc, ld, lp, spec.sid, null);
    for (const cell of placement.cells) if (state.slots[cell] !== spec.sid) { placement.cells.forEach(k => { if (state.slots[k] === spec.sid) delete state.slots[k]; }); return false; }
    return true;
  }
  const [c, d, p] = placement.cells[0].split('|');
  if (!canPlaceAt(c, d, p, spec.sid, spec.teacherId)) return false;
  placeSubject(c, d, p, spec.sid, spec.teacherId);
  return true;
}
// 搜尋把 spec 排入的方案（含跨班連鎖）。回 {placement, moves:[{from,to,sid}]} 或 null。mutating（外層負責快照還原）。
function tryPlace(spec, depth, avoid, budget) {
  for (const placement of targetPlacements(spec, avoid)) {
    if (budget.n-- <= 0) return null;
    if (budget.deadline && performance.now() > budget.deadline) return null;   // 時間截止：大規模連鎖不得無限跑
    const blk = blockersFor(placement, spec); if (blk === null) continue;
    if (blk.size === 0) {
      const snap = snapshotGrid();
      if (tentativePlaceSpec(spec, placement)) return { placement, moves: [] };
      restoreGrid(snap); continue;
    }
    if (depth <= 0) continue;
    const snap = snapshotGrid(); const moves = []; const newAvoid = new Set(avoid); placement.cells.forEach(k => newAvoid.add(k));
    let ok = true;
    for (const bkey of blk) {
      const r = relocateOffering(bkey, depth - 1, newAvoid, budget);
      if (!r) { ok = false; break; }
      moves.push(...r.moves); newAvoid.add(r.toKey);
    }
    if (ok && tentativePlaceSpec(spec, placement)) return { placement, moves };
    restoreGrid(snap);
  }
  return null;
}
// 局部重排時限制連鎖修復只可搬動「範圍內班級」的課（null＝不限，喬課/全校用）
let autoRelocScope = null;
// 分階段排課「硬鎖」格集合（null＝不限）：連鎖修復/局部搜尋一律不得搬動這些格（如階段1母語）
let autoHardLocked = null;
// 把某格的「單純占用課」搬到本班其他合法格（可再連鎖）。回 {moves, toKey} 或 null。mutating。
function relocateOffering(key, depth, avoid, budget) {
  const sid = state.slots[key]; const cId = key.split('|')[0];
  if (!sid || !isSimpleSubject(sid, cId)) return null;
  if (autoHardLocked && autoHardLocked.has(key)) return null;    // 硬鎖格不得搬動（分階段：階段1定案）
  if (autoRelocScope && !autoRelocScope.has(cId)) return null;   // 局部重排：不得搬動範圍外（凍結）的課
  const snap = snapshotGrid();
  delete state.slots[key]; delete state.slotTeachers[key];
  const av = new Set(avoid); av.add(key);
  const r = tryPlace({ classId: cId, sid, teacherId: null }, depth, av, budget);
  if (!r) { restoreGrid(snap); return null; }
  return { moves: [...r.moves, { from: key, to: r.placement.cells[0], sid }], toKey: r.placement.cells[0] };
}
// 對外：找調課方案（state-preserving）。回 {targetCells, kind, moves} 或 null。
function findRelocationPlan(spec, maxDepth, opts) {
  const snap = snapshotGrid(); const budget = { n: (opts && opts.budgetN) || 8000, deadline: (opts && opts.deadline) || 0 }; let r = null;
  try { r = tryPlace(spec, maxDepth, new Set(), budget); } finally { restoreGrid(snap); }
  return r ? { targetCells: r.placement.cells, kind: r.placement.kind, moves: r.moves } : null;
}
// 求解用：直接把 spec 以連鎖方式排入（會實際搬移已排的單純課）；成功回 true。不進 undo/render/save。
// opts＝{ budgetN, deadline }（求解時限制運算量與時間；互動式喬課不帶＝沿用預設）
function placeWithChain(spec, maxDepth, opts) {
  const plan = findRelocationPlan(spec, maxDepth, opts); if (!plan) return false;
  plan.moves.forEach(m => { delete state.slots[m.from]; delete state.slotTeachers[m.from]; state.slots[m.to] = m.sid; });
  if (plan.kind === 'coteach') { const [c, d, p] = plan.targetCells[0].split('|'); placeSubject(c, d, p, spec.sid, null); }
  else plan.targetCells.forEach(k => { const [c, d, p] = k.split('|'); placeSubject(c, d, p, spec.sid, spec.teacherId); });
  return true;
}
// spec 是否有直接（免搬移）落點——供調色盤判定「卡住」與是否顯示喬課
function canPlaceDirect(spec) {
  for (const pl of targetPlacements(spec, new Set())) { const b = blockersFor(pl, spec); if (b && b.size === 0) return true; }
  return false;
}
function specRemaining(spec) {
  const s = subjectById(spec.sid);
  return (s && s.splitTeachers) ? subjectRemaining(spec.classId, spec.sid, spec.teacherId) : subjectRemaining(spec.classId, spec.sid, null);
}
function isSpecStuck(spec) { return specRemaining(spec) > 0 && !canPlaceDirect(spec); }
// 放課共用邏輯（協同同步 + 連堂成對），回傳提示；供手動點格與建議放入共用
function placeWithExtras(classId, day, period, sid, tid) {
  pushUndo();
  const s = subjectById(sid); const dNum = parseInt(day, 10); const notes = [];
  const linked = placeSubject(classId, day, period, sid, tid);
  if (linked) notes.push(`協同同步 ${linked} 班`);
  // 手動放連堂科目時自動補上相鄰那節（依科目「連堂次數」為額度，超出的節數單獨排）；v09.16 併掉原全域「自動成對」開關
  if (s && s.consecutive && subjectPlaced(classId, sid) < classSubjectRequired(classId, sid)
      && subjectPlaced(classId, sid) <= 2 * consecutiveTarget(sid, classSubjectRequired(classId, sid))) {
    const g = classGrade(classById(classId));
    const next = adjacentOpenPeriod(g, period, dNum, +1), prev = adjacentOpenPeriod(g, period, dNum, -1);
    const partner = (next && !state.slots[slotKey(classId, day, next)]) ? next : (prev && !state.slots[slotKey(classId, day, prev)]) ? prev : null;
    if (partner) { const l2 = placeSubject(classId, day, partner, sid, tid); notes.push('連堂成對排入相鄰節' + (l2 ? `（協同 ${l2} 班）` : '')); }
    else notes.push('連堂：找不到相鄰空格');
  }
  save();
  return notes;
}
// 定稿後：導師點釋放的自編空格，從「本班導師的配課科目」選課（追蹤各科節數）
function selfCellPickModal(key) {
  const [classId, day, period] = key.split('|');
  const hr = homeroomTeacher(classId);
  const pool = selfCoursePool(classId);
  const current = state.slots[key] || '';
  const chips = pool.map(s => {
    const req = selfCourseTarget(classId, s.id), pl = selfCoursePlaced(classId, s.id);
    const full = pl >= req, isCur = current === s.id;
    return `<button class="suggest-row ${isCur ? 'selected' : ''}" data-action="pick-selfcourse" data-key="${esc(key)}" data-sid="${s.id}" ${full && !isCur ? 'disabled' : ''}>
      <span class="sug-dot" style="background:${s.color}"></span>
      <span><b>${esc(s.name)}</b> <span style="color:${pl > req ? 'var(--danger)' : full ? 'var(--ok)' : 'var(--muted)'}">${pl}/${req}${full && !isCur ? '（已滿）' : ''}</span></span></button>`;
  }).join('');
  openModal({
    title: `選課 · ${(classById(classId) || {}).name || ''} ${DAY_LABELS[+day]}${periodLabel(period)}`,
    body: pool.length
      ? `<p style="margin-top:0;color:var(--muted)">從本班導師（${esc(hr ? hr.name : '')}）的配課科目挑一節放入（顯示 已排／應排；達應排即不可再放）。</p>
         <div class="suggest-list">${chips}</div>
         ${current ? `<div style="margin-top:10px"><button class="ghost" data-action="clear-selfcell" data-key="${esc(key)}">清空此格</button></div>` : ''}`
      : `<p style="color:var(--muted)">本班沒有級任導師、或導師在本班無配課，無可選科目。請到「③ 教師」設定本班導師與其配課。</p>`,
  });
}
function cellSuggestModal(classId, day, period) {
  const sugg = suggestionsForCell(classId, day, period);
  const head = `<p style="margin-top:0">「${esc((classById(classId) || {}).name || '')}」${DAY_LABELS[+day]} ${esc(periodLabel(period))} 這一格可以放：</p>`;
  if (!sugg.length) { openModal({ title: '空格建議', body: head + `<p style="color:var(--muted)">目前沒有可放的課——可能該班的課都排完了，或剩下的科目受衝堂/排課限制擋住。若某科排不下，可用左側調色盤該科的「🔧 喬課」看調課建議。</p>` }); return; }
  const key = slotKey(classId, day, period);
  const rows = sugg.map(x => `<button class="suggest-row" data-action="place-suggestion" data-key="${key}" data-sid="${x.sid}" data-teacher="${x.teacherId || ''}">
      <span class="sug-dot" style="background:${x.color}"></span>
      <span><b>${x.split ? '✂️' : ''}${esc(x.name)}</b> <span style="color:var(--muted)">· ${esc(x.teacherLabel)}</span></span>
    </button>`).join('');
  openModal({ title: '空格建議 · 點一項放入', body: head + `<div class="suggest-list">${rows}</div>` });
}
// 一格的簡短座標描述（含班名，供跨班調課步驟閱讀）
function cellLabel(key, withClass) {
  const [cId, d, p] = key.split('|');
  return `${withClass ? esc((classById(cId) || {}).name || '') + ' ' : ''}${DAY_LABELS[+d]}${esc(periodLabel(p))}`;
}
// 套用調課方案：依序重放搬移，再放入目標課（協同/連堂自動同步／成對）
function applyRelocationPlan(spec, plan) {
  pushUndo();
  plan.moves.forEach(m => { delete state.slots[m.from]; delete state.slotTeachers[m.from]; state.slots[m.to] = m.sid; });
  if (plan.kind === 'coteach') { const [c, d, p] = plan.targetCells[0].split('|'); placeSubject(c, d, p, spec.sid, null); }
  else plan.targetCells.forEach(k => { const [c, d, p] = k.split('|'); placeSubject(c, d, p, spec.sid, spec.teacherId); });
  save(); render();
}
function swapSuggestModal(classId, sid, teacherId) {
  const spec = { classId, sid, teacherId: teacherId || null };
  const s = subjectById(sid); const clsName = (classById(classId) || {}).name || '';
  const c = classById(classId);
  if (s.consecutive && c.coteach && c.coteach[sid]) { openModal({ title: '調課建議', body: `<p style="margin-top:0">「${esc(subjectName(sid))}」同時是連堂＋協同，這種組合的自動調課較複雜，暫請手動處理。</p>` }); return; }
  const plan = findRelocationPlan(spec, 3);
  if (!plan) { openModal({ title: '調課建議', body: `<p style="margin-top:0">找不到 3 步內的調課方式，讓「${esc(subjectName(sid))}」排進「${esc(clsName)}」。</p><p style="color:var(--muted)">建議：放寬該科的排課限制、調整教師不排課時段或單日上限、或先手動挪動更多課後再試。</p>` }); return; }
  const stepHtml = plan.moves.map(m => {
    const crossClass = m.from.split('|')[0] !== classId;
    return `<li>把「<b>${esc(subjectName(m.sid))}</b>」從 ${cellLabel(m.from, true)} → 移到 ${cellLabel(m.to, true)}${crossClass ? '　<span style="color:var(--warn)">（跨班）</span>' : ''}</li>`;
  }).join('');
  const targetDesc = plan.kind === 'coteach'
    ? `${cellLabel(plan.targetCells[0], false)}（協同同步 ${plan.targetCells.length} 班）`
    : plan.kind === 'consec'
      ? `${cellLabel(plan.targetCells[0], false)} + ${cellLabel(plan.targetCells[1], false)}（連堂相鄰兩節）`
      : cellLabel(plan.targetCells[0], false);
  const finalHtml = `<li>再把「<b>${esc(subjectName(sid))}</b>」放到 ${targetDesc}</li>`;
  const crossNote = plan.moves.some(m => m.from.split('|')[0] !== classId) ? '　本方案含<b>跨班</b>調整（因老師/教室在別班被占用）。' : '';
  const body = `<p style="margin-top:0">要讓「<b>${esc(subjectName(sid))}</b>」排進「${esc(clsName)}」，建議這樣調（${plan.moves.length ? plan.moves.length + ' 步移動' : '直接放入'}）：</p>
    <ol style="line-height:1.9">${stepHtml}${finalHtml}</ol>
    <p style="color:var(--muted);font-size:12px">套用後不會產生任何衝堂；若不滿意可用「復原」還原。${crossNote}</p>`;
  openModal({ title: '調課建議', wide: true, body, saveLabel: '套用建議', onSave: () => { applyRelocationPlan(spec, plan); toast('已套用調課建議'); return true; } });
}

/* ---------- A7 教師視角「哪幾格可調」總覽（唯讀分析，不動資料） ---------- */
let flexTeacherId = null;
// 逐格暫時清空該師的課，數同班內還有幾個合法空格可搬（state-preserving）
function teacherFlexOverview(teacherId) {
  const t = teacherById(teacherId); if (!t) return { rows: [], movable: 0, stuck: 0 };
  const teaches = new Set((t.load || []).map(L => L.classId + '|' + L.subjectId));
  const rows = []; const savedSlots = { ...state.slots }, savedST = { ...state.slotTeachers };
  try {
    const keys = Object.keys(savedSlots).filter(key => {
      const sid = savedSlots[key]; const classId = key.split('|')[0];
      if (!teaches.has(classId + '|' + sid)) return false;
      const s = subjectById(sid);
      if (s && s.splitTeachers && savedST[key] !== teacherId) return false;   // 分節：只算本師實際上的那幾節
      return true;
    });
    for (const key of keys) {
      const sid = savedSlots[key]; const [classId, dayStr, period] = key.split('|'); const day = parseInt(dayStr, 10);
      const s = subjectById(sid); const tId = (s && s.splitTeachers) ? teacherId : null;
      delete state.slots[key]; const stt = state.slotTeachers[key]; if (stt) delete state.slotTeachers[key];   // 暫時清空此格
      const alts = candidateCells(classId, sid, tId).filter(c => !(c.day === day && c.period === period));
      state.slots[key] = sid; if (stt) state.slotTeachers[key] = stt;                                          // 還原
      rows.push({ classId, className: (classById(classId) || {}).name || '', subjectName: subjectName(sid), day, period, alt: alts.length, simple: isSimpleSubject(sid, classId) });
    }
  } finally { state.slots = savedSlots; state.slotTeachers = savedST; }
  rows.sort((a, b) => (a.day - b.day) || String(a.period).localeCompare(String(b.period)) || a.className.localeCompare(b.className, 'zh-Hant'));
  return { rows, movable: rows.filter(r => r.alt > 0).length, stuck: rows.filter(r => r.alt === 0).length };
}
function flexOverviewModal() {
  if (!state.teachers.length) { toast('尚無教師'); return; }
  if (!flexTeacherId || !teacherById(flexTeacherId)) flexTeacherId = state.teachers[0].id;
  const { rows, movable, stuck } = teacherFlexOverview(flexTeacherId);
  const sel = `<select id="flexTeacher" data-change="flex-teacher">${state.teachers.map(t => `<option value="${t.id}" ${t.id === flexTeacherId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
  const body = rows.length ? `<table class="data"><thead><tr><th>班級</th><th>時段</th><th>科目</th><th>可調性</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.className)}</td><td>${DAY_LABELS[r.day]}${esc(periodLabel(r.period))}</td><td>${esc(r.subjectName)}</td>
        <td>${r.alt > 0 ? `<span style="color:var(--ok);font-weight:700">可移到 ${r.alt} 處</span>${r.simple ? '' : ' <span style="color:var(--warn)" title="分組/協同/分節/連堂：搬移需連動夥伴班或整對，僅供參考">⚠ 需連動</span>'}` : '<span style="color:var(--danger);font-weight:700">⛔ 卡死（無其他合法空格）</span>'}</td></tr>`).join('')}
      </tbody></table>
      <p style="color:var(--muted);font-size:12px;margin-top:8px">「可移到 N 處」＝把這一節從原格拿掉後，同班內還有 N 個<b>不衝堂、符合限制</b>的空格可放。<b>單純科</b>可直接手動搬；標 ⚠ 的分組/協同/分節/連堂需連動夥伴班或整對移動，數字僅供參考。此總覽只分析、不會更動課表。</p>`
    : `<p style="margin-top:0;color:var(--muted)">此教師目前沒有已排的課。</p>`;
  openModal({ title: '🧭 教師可調課總覽', wide: true, body:
    `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><label>教師：</label>${sel}
       ${rows.length ? `<span style="margin-left:auto;color:var(--muted)">可調 <b style="color:var(--ok)">${movable}</b> · 卡死 <b style="color:var(--danger)">${stuck}</b>（共 ${rows.length} 節）</span>` : ''}</div>${body}` });
}

function viewSchedule() {
  if (state.classes.length === 0) return coreHead('schedule') + emptyState('尚未建立班級', '請先完成 ①科目 ②年級與班級 ③教師，再來排課。');
  if (!staffingConfirmed()) {
    const problems = checkStaffing();
    const noHr = unsetHomerooms();
    const detail = staffingClear()
      ? '資料已齊，但尚未在「③ 教師」按過「檢查全校配課」完成確認。'
      : `${problems.length ? `配課問題 ${problems.length} 項；` : ''}${noHr.length ? `未設導師班級 ${noHr.length} 個（${esc(noHr.join('、'))}）；` : ''}請修正後在「③ 教師」按「檢查全校配課」。`;
    return coreHead('schedule') + `
    <div class="card"><div class="card-body">
      <div class="conflict-banner">⚠ 尚未通過全校檢查，無法開始排課。<div style="font-weight:400;margin-top:4px">${detail}</div></div>
      <button class="btn" data-action="goto-teachers">前往 ③ 教師 檢查全校配課</button>
    </div></div>`;
  }
  if (!selectedClassId || !classById(selectedClassId)) selectedClassId = state.classes[0].id;
  const conflicts = computeConflicts();
  const totalConf = Object.keys(conflicts).length;
  const finalized = !!state.lockFinalized;
  const selecting = lockMode;
  const boardBusy = finalized || selecting;   // 定稿或單格選取中：隱藏調色盤/自動排課
  const classOpts = state.classes.map(c => `<option value="${c.id}" ${c.id === selectedClassId ? 'selected' : ''}>${esc(c.name)}（${esc(gradeName(c.gradeId))}）</option>`).join('');
  const hint = selecting
    ? '單格鎖定中：<b>點格切換鎖定</b>（🔒＝已鎖）。<b>🧩 格＝級任導師任課</b>，完成鎖定後自動釋放為導師自編、<b>不可鎖</b>。選好後按「✔ 完成鎖定」。'
    : finalized
      ? '課表已鎖定（定稿）：<b>已釋放自編格</b>供導師點選課程；被鎖的格唯讀。要調整請先解除鎖定。'
      : '左側點科目→點空格放課；點已排格移除。<b>點空格（未選科目）</b>會列出「這格可放什麼」；排不下的科目按「🔧 喬課」看調課建議。';
  const selCls = selectedClassId;
  const selfCellCount = finalized ? classSelfCells(selCls).length : 0;
  const selfDoneCls = !!(state.selfDone && state.selfDone[selCls]);
  const selfBtn = selfCellCount
    ? (selfDoneCls
        ? `<button class="btn" data-action="self-unlock" data-cls="${selCls}" title="排課者解鎖，導師可重新選課">🔓 解鎖導師自編</button>`
        : `<button class="btn" data-action="self-done" data-cls="${selCls}" title="鎖定本班導師自編選課（有空格或衝堂會拒絕）">✅ 導師自編完成</button>`)
    : '';
  const banner = selecting
    ? `<div class="lock-banner no-print"><span>🎯 單格鎖定中——點要鎖的格（再點取消）。目前已鎖 <b>${(state.lockedCells || []).length}</b> 格。</span><button class="btn" data-action="lockcell-done">✔ 完成鎖定</button><button class="ghost" data-action="lockcell-cancel">取消</button></div>`
    : finalized
      ? `<div class="lock-banner no-print"><span>🔒 課表已鎖定（${state.locked ? '一鍵全鎖' : '單格鎖定 ' + (state.lockedCells || []).length + ' 格'}）。自編格已釋放供導師選課${selfCellCount ? `；本班（${esc((classById(selCls) || {}).name || '')}）自編 ${selfDoneCls ? '已完成🔒' : selfCellCount + ' 格'}` : ''}；其餘鎖定格唯讀。</span>${selfBtn}<button class="ghost" data-action="fill-manage" title="開放/收回導師線上填課">☁️ 線上填課${state.fillShare ? '（已開放）' : ''}</button><button class="btn" data-action="unlock-schedule">🔓 解除鎖定</button></div>`
      : '';
  const clearBtn = `<button class="ghost" data-action="clear-schedule" title="清空排課（全校或指定班級；已鎖定的格不清）">🧹 清空</button>`;
  const toolbarBtns = selecting ? '' : finalized ? clearBtn :
    `${clearBtn}<button class="ghost" data-action="lock-schedule" title="整表一次鎖定">🔒 一鍵鎖定</button><button class="ghost" data-action="lockcell-mode" title="逐格點選要鎖的格">🎯 單格鎖定</button><button class="btn" data-action="auto-schedule">🪄 自動排課</button>`;
  const loadHtml = teacherLoadHTML();   // 教師已排/應排：拆成獨立卡片
  return coreHead('schedule') + `
    <div class="page-head no-print" style="margin-top:-4px"><div class="hint">${hint}</div></div>
    ${banner}
    ${totalConf ? `<div class="conflict-banner no-print">⚠ 全校目前有 ${totalConf} 個需注意的格子（教師衝堂／不排課／協同未同步／連堂未相鄰）。</div>` : ''}
    <div class="board-toolbar no-print"><label>班級：</label><select id="scheduleClass" data-change="schedule-class">${classOpts}</select>
      ${selecting ? '' : `<button class="ghost" data-action="undo-schedule" title="復原 (Ctrl+Z)">↶ 復原</button><button class="ghost" data-action="redo-schedule" title="重做 (Ctrl+Y／Ctrl+Shift+Z)">↷ 重做</button><button class="ghost" data-action="flex-overview" title="看某位教師的課哪些格可調到別處">🧭 教師可調總覽</button>`}
      <span style="margin-left:auto"></span>${toolbarBtns}</div>
    <div class="schedule-layout ${boardBusy ? 'locked' : ''}">
      ${boardBusy ? '' : `<div class="palette card no-print"><div class="card-body"><h4>科目調色盤</h4>${paletteHTML(selectedClassId)}</div></div>`}
      <div class="card"><div class="card-body">
        <div class="grid-wrap">${classTimetableHTML(selectedClassId, conflicts, true)}</div>
      </div></div>
    </div>
    ${loadHtml ? `<div class="card teacher-load-card no-print"><div class="card-body">${loadHtml}</div></div>` : ''}`;
}
function paletteHTML(classId) {
  const c = classById(classId); const subs = classSubjectHours(c);
  if (subs.length === 0) return `<div class="empty">此班年級尚未設定科目節數</div>`;
  const chips = [];
  subs.forEach(sh => {
    const sid = sh.subjectId; const s = subjectById(sid); if (!s) return;
    if (s.splitTeachers) {
      // 分節上課：每位配課老師各一色塊，各自 已排/該師節數
      const loads = loadsForClassSubject(classId, sid);
      if (loads.length === 0) {
        chips.push(`<div class="chip" style="border-left-color:${s.color};opacity:.6"><div><div class="chip-name">✂️${esc(s.name)}</div><div class="chip-sub">尚未在「③教師」配課</div></div></div>`);
        return;
      }
      loads.forEach(L => {
        const tid = L.teacher.id; const placed = placedByTeacher(classId, sid, tid);
        const done = placed >= L.hours, over = placed > L.hours;
        const seld = sid === selectedSubjectId && tid === selectedTeacherId;
        const room = L.roomId ? ' · ' + esc(roomName(L.roomId)) : '';
        const stuck = !done && isSpecStuck({ classId, sid, teacherId: tid });
        chips.push(`<div class="chip ${seld ? 'selected' : ''} ${done && !over ? 'done' : ''}" style="border-left-color:${s.color}" data-action="select-subject" data-id="${sid}" data-teacher="${tid}">
          <div><div class="chip-name">✂️${s.consecutive ? '⏱' : ''}${esc(s.name)}</div>
            <div class="chip-sub">${esc(L.teacher.name)}${room}</div></div>
          ${stuck ? `<button class="ghost mini" data-action="suggest-swap" data-id="${sid}" data-teacher="${tid}" title="這科排不下，看調課建議">🔧 喬課</button>` : ''}
          <span class="chip-count" style="color:${over ? 'var(--danger)' : done ? 'var(--ok)' : 'var(--muted)'}">${placed}/${L.hours}</span>
        </div>`);
      });
      return;
    }
    const placed = subjectPlaced(classId, sid); const done = placed >= sh.hours, over = placed > sh.hours;
    const partners = classCoteachPartners(c, sid);
    const seld = sid === selectedSubjectId && !selectedTeacherId;
    const stuck = !done && isSpecStuck({ classId, sid, teacherId: null });
    chips.push(`<div class="chip ${seld ? 'selected' : ''} ${done && !over ? 'done' : ''}" style="border-left-color:${s.color}" data-action="select-subject" data-id="${sid}">
      <div><div class="chip-name">${s.allowGrouping ? '👥' : ''}${s.consecutive ? '⏱' : ''}${esc(s.name)}</div>
        <div class="chip-sub">${esc(subjectTeachersLabel(classId, sid))}${roomsLabelCS(classId, sid) ? ' · ' + esc(roomsLabelCS(classId, sid)) : ''}${partners.length ? ' · 🔗協同' : ''}</div></div>
      ${stuck ? `<button class="ghost mini" data-action="suggest-swap" data-id="${sid}" title="這科排不下，看調課建議">🔧 喬課</button>` : ''}
      <span class="chip-count" style="color:${over ? 'var(--danger)' : done ? 'var(--ok)' : 'var(--muted)'}">${placed}/${sh.hours}</span>
    </div>`);
  });
  return chips.join('');
}
function classTimetableHTML(classId, conflicts, editable) {
  const days = activeDays(); const c = classById(classId); const g = classGrade(c);
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc((c || {}).name || '')} 課表</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}　${esc(p.start)}–${esc(p.end)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const open = g && gradePeriodHasDay(g, p.id, d);
      const key = slotKey(classId, d, p.id); const sid = state.slots[key]; const conf = conflicts[key];
      const selecting = editable && lockMode;                       // 單格選取中
      const cellSel = (state.lockedCells || []).includes(key);      // 此格已在單格鎖定清單
      const isLocked = editable && cellIsLocked(key);               // 定稿後此格唯讀
      const selfCell = state.lockFinalized && isSelfCell(key);      // 系統偵測的自編格（定稿後釋放）
      const selfPreview = editable && !state.lockFinalized && !!sid && isSelfSlot(key); // 定稿前即時預覽：本班級任導師任課
      const canSelect = selecting && !selfPreview;                  // 自編（預覽）格在單格鎖定時不可鎖
      const lockMark = isLocked ? '<span class="lock-mark">🔒</span>' : '';
      const selMark = canSelect && cellSel ? '<span class="lock-mark sel">🔒</span>' : '';
      const dataAct = editable ? `data-action="cell-click" data-key="${key}"` : '';
      if (selfCell) {                                               // 自編格：導師選課（釋放後不論空/已選）
        const s = sid ? subjectById(sid) : null; const color = s ? s.color : '#dfeee7';   // 空自編格改用淺色凹槽底，讓「深挖」看得出來（已填則用科目色）
        const tlock = selfCellTeacherLocked(key);                   // v09.00 導師自編完成→唯讀
        const co = s ? classCoteachPartners(c, sid).length : 0;
        html += `<td class="cell ${editable ? 'placeable' : ''}" ${dataAct} title="${tlock ? '導師自編已鎖定（唯讀）' : '自編格（導師選課）'}">
          <div class="cell-lesson self-designed ${s ? '' : 'released'} ${tlock ? 'locked' : ''}" style="background:${color};color:${subjTextColor(s, color)}"><span class="cell-flag">${tlock ? '🔒' : '🧩'}${co ? '🔗' : ''}</span>${s ? esc(s.name) : '自編'}
            <small>${s ? esc(slotTeachersLabel(key)) : '＋ 點選課程'}</small></div></td>`;
      } else if (sid) {
        const s = subjectById(sid); const color = s ? s.color : '#94a3b8';
        const co = classCoteachPartners(c, sid).length;
        const selfBadge = selfPreview ? '<span class="lock-mark self" title="級任導師任課：完成鎖定後將自動釋放為導師自編">🧩</span>' : '';
        html += `<td class="cell ${editable ? 'placeable' : ''} ${canSelect ? 'lock-target' : ''} ${cellSel ? 'lock-sel' : ''} ${selfPreview ? 'self-preview' : ''}" ${dataAct} title="${selfPreview ? '級任導師任課→完成鎖定後自動釋放為導師自編（單格鎖定時不可鎖）' : (conf ? esc(conf.join('；')) : '')}">
          <div class="cell-lesson ${conf ? 'conflict' : ''} ${isLocked ? 'locked' : ''}" style="background:${color};color:${subjTextColor(s, color)}">
            ${lockMark}${selMark}${selfBadge}<span class="cell-flag">${co ? '🔗' : ''}${s && s.allowGrouping ? '👥' : ''}${s && s.splitTeachers ? '✂️' : ''}</span>${esc(subjectName(sid))}
            <small>${esc(slotTeachersLabel(key))}${!(s && s.splitTeachers) && roomsLabelCS(classId, sid) ? '·' + esc(roomsLabelCS(classId, sid)) : ''}</small>
            ${conf ? `<span class="conf-mark">⚠ ${conf.some(x => x.includes('衝堂') || x.includes('不排課')) ? '衝堂' : conf.some(x => x.startsWith('協同')) ? '協同未同步' : '連堂未相鄰'}</span>` : ''}
          </div></td>`;
      } else if (open) {
        html += `<td class="cell ${editable ? 'placeable' : ''} ${editable && !isLocked ? 'open-empty' : ''} ${canSelect ? 'lock-target' : ''} ${cellSel ? 'lock-sel' : ''} ${isLocked ? 'blocked-lock' : ''}" ${dataAct}>${lockMark}${selMark}</td>`;
      } else {
        html += `<td class="cell blocked" title="此節本日不上課"></td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}
function teacherLoadHTML() {
  if (state.teachers.length === 0) return '';
  const rows = state.teachers.map(t => {
    const sched = teacherScheduled(t); const total = teacherLoadSum(t); const over = sched > total; const pct = total ? Math.min(100, sched / total * 100) : 0;
    return `<tr><td>${esc(t.name)} <span class="pill gray">${esc(t.type || '')}</span></td>
      <td style="width:200px"><div class="load-bar ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div></td>
      <td style="white-space:nowrap;color:${sched === total ? 'var(--ok)' : 'var(--muted)'};font-weight:700">${sched} / ${total} 節</td></tr>`;
  }).join('');
  return `<h4 style="margin:14px 0 8px">教師已排 / 應排</h4><table class="data"><tbody>${rows}</tbody></table>`;
}

function viewOutput() {
  if (state.classes.length === 0) return subHead('課表輸出', '', 'no-print') + emptyState('尚無資料', '請先完成前面步驟並排課。');
  const conflicts = computeConflicts();
  const isMaster = outputMode === 'school' || outputMode === 'schoolTeacher';
  if (outputMode === 'class') { if (!outputClassId || !classById(outputClassId)) outputClassId = state.classes[0].id; }
  else if (outputMode === 'teacher') { if (state.teachers.length === 0) { outputMode = 'class'; outputClassId = state.classes[0].id; } else if (!outputTeacherId || !teacherById(outputTeacherId)) outputTeacherId = state.teachers[0].id; }
  const picker = outputMode === 'class'
    ? `<select id="outClass" data-change="out-class">${state.classes.map(c => `<option value="${c.id}" ${c.id === outputClassId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
    : outputMode === 'teacher'
      ? `<select id="outTeacher" data-change="out-teacher">${state.teachers.map(t => `<option value="${t.id}" ${t.id === outputTeacherId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`
      : '';   // 全校總表：無需下拉選單
  const actions = isMaster
    ? `<button class="ghost" data-action="print-out">🖨️ 列印 / 存 PDF（橫向）</button>
       <button class="btn" data-action="master-png">🖼️ 下載 PNG</button>`
    : `<button class="ghost" data-action="print-out">🖨️ 列印 / 存 PDF</button>
       <button class="ghost" data-action="csv-out">⬇️ 匯出 CSV</button>
       <span style="width:1px;height:20px;background:var(--line);margin:0 4px"></span>
       <button class="btn" data-action="all-class-docx">📄 所有班級課表(.docx)</button>
       <button class="btn" data-action="all-teacher-docx">📄 所有教師課表(.docx)</button>`;
  const modeSel = `<div class="board-toolbar no-print">
      <label>類型：</label>
      <select id="outMode" data-change="out-mode"><option value="class" ${outputMode === 'class' ? 'selected' : ''}>班級課表</option><option value="teacher" ${outputMode === 'teacher' ? 'selected' : ''}>教師課表</option><option value="school" ${outputMode === 'school' ? 'selected' : ''}>全校總表（各班）</option><option value="schoolTeacher" ${outputMode === 'schoolTeacher' ? 'selected' : ''}>全校教師總表</option></select>
      ${picker}${actions}</div>`;
  const grid = outputMode === 'class' ? classTimetableHTML(outputClassId, conflicts, false)
    : outputMode === 'teacher' ? teacherTimetableHTML(outputTeacherId, conflicts)
    : masterTableHTML(outputMode);
  return subHead('課表輸出', '', 'no-print') + `${modeSel}<div class="card"><div class="card-body"><div class="grid-wrap">${grid}</div></div></div>`;
}
function teacherTimetableHTML(teacherId, conflicts) {
  const days = activeDays(); const t = teacherById(teacherId);
  const teaches = new Set((t.load || []).map(L => L.classId + '|' + L.subjectId));
  const map = {};
  for (const key in state.slots) {
    const sid = state.slots[key]; const [classId, day, period] = key.split('|');
    if (!teaches.has(classId + '|' + sid)) continue;
    const s = subjectById(sid);
    if (s && s.splitTeachers && state.slotTeachers[key] !== teacherId) continue; // 分節：別位老師的節不算進來
    (map[day + '|' + period] = map[day + '|' + period] || []).push({ classId, sid, key });
  }
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc((t || {}).name || '')} 教師課表</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const hits = map[d + '|' + p.id];
      if (hits && hits.length) {
        const s = subjectById(hits[0].sid); const color = s ? s.color : '#94a3b8';
        const conf = hits.some(h => conflicts[h.key]);
        const label = hits.map(h => (classById(h.classId) || {}).name || '').join('、');
        html += `<td class="cell"><div class="cell-lesson ${conf ? 'conflict' : ''}" style="background:${color};color:${subjTextColor(s, color)}">${esc(label)}<small>${esc(subjectName(hits[0].sid))}</small></div></td>`;
      } else html += `<td class="cell"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}
/* ==========================================================================
   代課（v09.45）：選被代課教師 → 調出課表 → 點有課格指派空堂教師 → 列印／存 PDF
   代課記錄存 state.substitutions（可多筆、可刪除）；assignments key＝slotKey(classId|day|period)。
   只影響代課課表輸出，不更動實際排課（state.slots 不動）。
   ========================================================================== */
const substById = id => (state.substitutions || []).find(x => x.id === id);

/* ---- v10.06 代課日期（開始/截止）與跨紀錄互斥 ---- */
// 舊資料相容：把單一 date（若為 yyyy-mm-dd）搬進 startDate/endDate；文字備註則日期留空（不參與互斥）。
function normalizeSubst(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (rec.startDate == null) {
    const d = (rec.date || '').trim();
    rec.startDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }
  if (rec.endDate == null || rec.endDate === '') rec.endDate = rec.startDate || '';
  if (!Array.isArray(rec.periods)) rec.periods = [];   // v10.13 請假節次（空＝全天）
  if (!rec.weekOverrides || typeof rec.weekOverrides !== 'object') rec.weekOverrides = {};   // v10.16 分週覆蓋：{'週index|班|星期|節':subId}
  return rec;
}
/* ---- v10.16 分週指派：長假中同一節可各週指派不同代課老師 ---- */
// 代課日期範圍涵蓋的「週」清單（只列含上課日的週；start/end 為該週實際涵蓋的起訖日）
function substWeeks(rec) {
  const s = rec && rec.startDate, e = rec && rec.endDate;
  if (!s || !e) return [];
  const start = new Date(s + 'T00:00:00'), end = new Date(e + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];
  const byMon = {}; const fmt = d => localDateStr(d);   // v10.16 用本地日期字串（避免 toISOString 在 UTC+8 下 -1 天）
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const wd = d.getDay(); if (wd < 1 || wd > 5) continue;
    const mon = new Date(d); mon.setDate(d.getDate() - (wd - 1)); const key = fmt(mon);
    if (!byMon[key]) byMon[key] = { start: new Date(d), end: new Date(d) };
    else { if (d < byMon[key].start) byMon[key].start = new Date(d); if (d > byMon[key].end) byMon[key].end = new Date(d); }
  }
  return Object.keys(byMon).sort().map((k, i) => ({ idx: i, mon: k, start: fmt(byMon[k].start), end: fmt(byMon[k].end) }));
}
const substMultiWeek = rec => substWeeks(rec).length > 1;
// 某週實際涵蓋的星期幾集合(1..5)
function weekWeekdays(week) {
  if (!week) return null;
  const start = new Date(week.start + 'T00:00:00'), end = new Date(week.end + 'T00:00:00');
  const set = new Set();
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) { const wd = d.getDay(); if (wd >= 1 && wd <= 5) set.add(wd); }
  return set;
}
// 某週(或 null=全部週為底)的有效指派 map：{'班|星期|節':subId}（覆蓋蓋過底）
function effAssign(rec, weekIdx) {
  const m = { ...(rec.assignments || {}) };
  if (weekIdx != null && rec.weekOverrides) {
    const pre = weekIdx + '|';
    for (const k in rec.weekOverrides) if (k.indexOf(pre) === 0) { const key = k.slice(pre.length); if (rec.weekOverrides[k]) m[key] = rec.weekOverrides[k]; }
  }
  return m;
}
// 某週某格的有效代課老師 id
function substEffectiveSub(rec, weekIdx, key) {
  if (weekIdx != null && rec.weekOverrides && rec.weekOverrides[weekIdx + '|' + key]) return rec.weekOverrides[weekIdx + '|' + key];
  return (rec.assignments || {})[key];
}
const substHasOverride = (rec, weekIdx, key) => weekIdx != null && !!(rec.weekOverrides && rec.weekOverrides[weekIdx + '|' + key]);
// v10.17 同一位被代課教師、日期+節次重疊的既有代課→回傳該筆（防重複請假填報）；無則 null
function substLeaveConflict(rec) {
  const tid = rec && rec.absentTeacherId;
  if (!tid || !rec.startDate || !rec.endDate) return null;
  const pers = lessonPeriods().map(p => p.id);
  for (const r2 of (state.substitutions || [])) {
    if (!r2 || r2.id === rec.id || r2.absentTeacherId !== tid || !r2.startDate || !r2.endDate) continue;
    let sharedWd = false;
    for (let wd = 1; wd <= 5 && !sharedWd; wd++) if (rangesShareWeekday(rec.startDate, rec.endDate, r2.startDate, r2.endDate, wd)) sharedWd = true;
    if (!sharedWd) continue;
    if (pers.some(p => substPeriodOnLeave(rec, p) && substPeriodOnLeave(r2, p))) return r2;
  }
  return null;
}
function normalizeAllSubst() { (state.substitutions || []).forEach(normalizeSubst); }
// 顯示用日期字串：「起～訖」；相同→單日；缺→空字串。
function fmtSubstRange(rec) {
  const s = rec && rec.startDate, e = rec && rec.endDate;
  if (!s && !e) return (rec && (rec.date || '').trim()) || '';   // 舊文字備註 fallback
  if (s && e && s !== e) return s + '～' + e;
  return s || e || '';
}
const substExpired = rec => !!(rec && rec.endDate && rec.endDate < localDateStr());
// 兩日期區間 [sA,eA]、[sB,eB] 的交集內是否出現指定星期幾(1=一..5=五)。任一端缺日期→視為不重疊(false)，
// 舊無日期資料不會誤擋。ISO 日期字串可直接字典序比較＝時序比較。
function rangesShareWeekday(sA, eA, sB, eB, weekday) {
  if (!sA || !eA || !sB || !eB) return false;
  const s = sA > sB ? sA : sB, e = eA < eB ? eA : eB;
  if (s > e) return false;
  const start = new Date(s + 'T00:00:00'), end = new Date(e + 'T00:00:00');
  const span = Math.round((end - start) / 86400000);
  if (span >= 6) return true;                    // 交集≥7天必含所有星期幾
  for (let i = 0; i <= span; i++) {
    if (new Date(start.getTime() + i * 86400000).getDay() === weekday) return true;   // getDay:1=一..5=五
  }
  return false;
}
// 因「別筆代課日期重疊」而不可代課的教師 → Map(teacherId → 原因字串)。
// 規則③：別筆在同(星期,節)已指派此人；規則④：此人是別筆的被代課(請假)者。
function substOtherBlockers(day, period, rec) {
  const m = new Map();
  if (!rec || !rec.startDate || !rec.endDate) return m;
  const wd = Number(day);
  const tailDP = k => { const parts = k.split('|'); return parts.length >= 2 ? { d: parts[parts.length - 2], p: parts[parts.length - 1] } : { d: '', p: '' }; };
  for (const r2 of (state.substitutions || [])) {
    if (!r2 || r2.id === rec.id) continue;
    if (!rangesShareWeekday(rec.startDate, rec.endDate, r2.startDate, r2.endDate, wd)) continue;
    const lbl = fmtSubstScope(r2);
    // v10.16 掃 r2 的底指派＋分週覆蓋（key 尾兩段皆為 星期|節），保守擋掉所有在此(星期,節)代課的人
    const scan = obj => { for (const k in (obj || {})) { const { d, p } = tailDP(k); if (d === String(day) && p === String(period) && obj[k]) m.set(obj[k], `${teacherName(obj[k])} 已在 ${teacherName(r2.absentTeacherId)} 的代課（${lbl}）`); } };
    scan(r2.assignments); scan(r2.weekOverrides);
    // v10.13 被代課者本人請假中，僅在「該節也在其請假範圍」時才不可代課（半天/指定節次請假者，其他節仍可代）
    if (r2.absentTeacherId && substPeriodOnLeave(r2, period)) m.set(r2.absentTeacherId, `${teacherName(r2.absentTeacherId)} 該期間請假中（${lbl}）`);
  }
  return m;
}

// 某(day,period) 正在上課（忙碌）的教師 id 集合
function busyTeachersAt(day, period) {
  const set = new Set();
  for (const key in state.slots) {
    const [, d, p] = key.split('|');
    if (d === String(day) && p === String(period)) slotAssignments(key).forEach(a => a.teacherId && set.add(a.teacherId));
  }
  return set;
}
// 某(day,period) 可代課的教師：不上課、未設不排課時段、非被代課者、且未在本記錄同節被指派為別格代課
function freeTeachersAt(day, period, rec, weekIdx = null) {
  const busy = busyTeachersAt(day, period);
  const usedThisDP = new Set();
  // v10.16 同記錄同(星期,節)已指派別格者，依「目前檢視的週」的有效指派判定
  if (rec) { const eff = effAssign(rec, weekIdx); for (const k in eff) { const [, d, p] = k.split('|'); if (d === String(day) && p === String(period) && eff[k]) usedThisDP.add(eff[k]); } }
  const blocked = substOtherBlockers(day, period, rec);   // v10.06 日期重疊的跨紀錄互斥
  return state.teachers.filter(t =>
    t.id !== rec.absentTeacherId &&
    !busy.has(t.id) &&
    !(t.unavailable || []).includes(day + '|' + period) &&
    !usedThisDP.has(t.id) &&
    !blocked.has(t.id));
}
// 被代課教師本週有課的格（keys）
function absentCells(rec) {
  const keys = [];
  for (const key in state.slots) if (slotAssignments(key).some(a => a.teacherId === rec.absentTeacherId)) keys.push(key);
  return keys;
}
// v10.09 代課日期區間實際涵蓋的星期幾(1..5)；缺日期→null＝不限制(舊行為)。
// 只有落在這些星期幾的課才是「代課日」，其餘星期鎖定不可指派。
function substRangeWeekdays(rec) {
  if (!rec || !rec.startDate || !rec.endDate) return null;
  const start = new Date(rec.startDate + 'T00:00:00'), end = new Date(rec.endDate + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return null;
  const span = Math.round((end - start) / 86400000);
  const set = new Set();
  for (let i = 0; i <= span && set.size < 5; i++) {
    const wd = new Date(start.getTime() + i * 86400000).getDay();
    if (wd >= 1 && wd <= 5) set.add(wd);   // getDay:1=一..5=五
  }
  return set;
}
// v10.13 上午/下午節次 id（以 isBreak 午休為界；無 break 則對半分）
function amPmPeriods() {
  const all = state.settings.periods || [];
  const nb = all.filter(p => !p.isBreak);
  const breakIdx = all.findIndex(p => p.isBreak);
  if (breakIdx < 0) { const h = Math.ceil(nb.length / 2); return { am: nb.slice(0, h).map(p => p.id), pm: nb.slice(h).map(p => p.id) }; }
  const am = [], pm = [];
  all.forEach((p, i) => { if (!p.isBreak) (i < breakIdx ? am : pm).push(p.id); });
  return { am, pm };
}
// v10.13 某節是否在請假範圍內（rec.periods 空＝全天）
function substPeriodOnLeave(rec, pid) {
  const ps = rec && rec.periods;
  return !Array.isArray(ps) || ps.length === 0 ? true : ps.includes(String(pid));
}
// 請假範圍文字：全天→''；上午/下午→對應詞；其餘→列節次名
function substPeriodLabel(rec) {
  const ps = rec && rec.periods;
  if (!Array.isArray(ps) || !ps.length) return '';
  const { am, pm } = amPmPeriods(); const set = new Set(ps.map(String));
  const eq = arr => arr.length === set.size && arr.every(x => set.has(String(x)));
  if (eq(am)) return '上午'; if (eq(pm)) return '下午';
  return lessonPeriods().filter(p => set.has(String(p.id))).map(p => p.label).join('、');
}
// 顯示用：日期 +（節次範圍）。全天不加後綴。
function fmtSubstScope(rec) {
  const range = fmtSubstRange(rec); const pl = substPeriodLabel(rec);
  return pl ? (range ? range + '（' + pl + '）' : pl) : range;
}
// 被代課者「在代課日期＋節次範圍內」有課的格（用於計「共 N 節」與範圍判定）
function absentCellsInScope(rec) {
  const wd = substRangeWeekdays(rec);
  return absentCells(rec).filter(k => { const [, d, p] = k.split('|'); return (!wd || wd.has(Number(d))) && substPeriodOnLeave(rec, p); });
}
// 某格(key=classId|day|period)是否落在本代課的日期＋節次範圍內
function substCellInScope(rec, key) {
  const [, d, p] = key.split('|'); const wd = substRangeWeekdays(rec);
  return (!wd || wd.has(Number(d))) && substPeriodOnLeave(rec, p);
}

function viewSubst() {
  if (state.teachers.length === 0)
    return subHead('🔄 代課') + emptyCard('尚無教師', '請先到「③ 教師」建立教師與配課，才能安排代課。');
  const rec = substOpenId ? substById(substOpenId) : null;
  if (rec && teacherById(rec.absentTeacherId)) return substEditor(rec);
  if (rec) substOpenId = null;   // 被代課教師已被刪除 → 回清單
  return substList();
}

function substList() {
  const shareBtn = substKiosk ? '' : `<button class="ghost" data-action="subst-share-manage">☁️ 線上代課填報${state.substShare ? '（已開放）' : ''}</button>`;
  const masterBtn = substKiosk ? '' : `<button class="ghost" data-action="subst-submaster">🧑‍🏫 代課老師合併總表</button>`;
  const addLabel = substKiosk ? '＋ 新增我的代課' : '＋ 新增代課';
  const head = subHead(`🔄 ${substKiosk ? '我的代課' : '代課'}`, `${masterBtn}${shareBtn}<button class="btn" data-action="subst-add">${addLabel}</button>`) +
    `<div class="hint" style="margin-bottom:12px;color:var(--muted)">${substKiosk
      ? `以下是<b>你（${esc(teacherName(substMyTeacherId) || substMyName)}）</b>的代課安排。按「＋ 新增我的代課」設定請假日期，即可調出<b>你自己的課表</b>為當週有課的格子指派代課老師，最後送出到雲端。<b>不同日期的請假請各按一次「＋ 新增我的代課」，會各自成一筆</b>；點既有的一筆是「編輯／重送」那一筆。`
      : '選一位<b>被代課（請假）教師</b>，調出其課表，點<b>有課的格子</b>指派當節<b>空堂</b>的代課教師，最後列印／存 PDF。記錄會保存、可多筆。'}</div>`;
  let list = state.substitutions || [];
  if (substKiosk) list = list.filter(r => r.absentTeacherId === substMyTeacherId);   // v10.10 教師端只看自己的代課
  if (!list.length) return head + emptyCard(substKiosk ? '你還沒有代課安排' : '尚無代課記錄', `點右上「${addLabel}」建立第一筆。`);
  const rows = list.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(r => {
    const t = teacherById(r.absentTeacherId);
    const total = t ? absentCellsInScope(r).length : 0;
    const done = Object.keys(r.assignments || {}).filter(k => r.assignments[k] && substCellInScope(r, k)).length;
    const mine = substKiosk && substEditableIds.has(r.id);
    const by = r.createdByName ? `<span class="subst-item-meta">填報：${esc(r.createdByName)}</span>` : '';
    const delBtn = substKiosk ? '' : `<button class="icon-btn subst-item-del" data-action="subst-del" data-id="${r.id}" title="刪除此代課記錄">🗑️</button>`;
    return `<div class="subst-item" data-action="subst-open" data-id="${r.id}">
      <div class="subst-item-main">
        <span class="subst-item-name">${esc((t || {}).name || '（教師已刪除）')}</span>
        ${fmtSubstScope(r) ? `<span class="pill blue">${esc(fmtSubstScope(r))}</span>` : ''}
        ${substExpired(r) ? '<span class="pill" style="background:#e5e7eb;color:#6b7280">已結束</span>' : ''}
        ${mine ? '<span class="pill amber">我的·可編輯</span>' : ''}
        <span class="subst-item-meta">已指派 ${done} / 共 ${total} 節</span>${by}
      </div>
      ${delBtn}
    </div>`;
  }).join('');
  return head + `<div class="subst-list">${rows}</div>`;
}

function substEditor(rec) {
  const t = teacherById(rec.absentTeacherId);
  const editable = !substKiosk || substEditableIds.has(rec.id);   // 完整 App 皆可編；kiosk 僅本 session 新建、未送出者
  const weeks = substWeeks(rec); const multi = weeks.length > 1;   // v10.16 分週指派
  if (!multi) substWeekTab = null;
  if (substWeekTab != null && substWeekTab >= weeks.length) substWeekTab = null;
  const wk = (substWeekTab != null) ? weeks[substWeekTab] : null;
  const eff = effAssign(rec, substWeekTab);
  const scopeKeys = wk
    ? absentCells(rec).filter(k => { const [, d, p] = k.split('|'); return weekWeekdays(wk).has(Number(d)) && substPeriodOnLeave(rec, p); })
    : absentCellsInScope(rec);
  const total = scopeKeys.length, done = scopeKeys.filter(k => eff[k]).length;
  const btns = substKiosk
    ? `<button class="ghost" data-action="subst-back">← 返回</button>${editable ? `<button class="btn" data-action="subst-submit" data-id="${rec.id}">💾 送出到雲端</button>` : ''}`
    : `<button class="ghost" data-action="subst-back">← 返回清單</button><button class="btn" data-action="subst-print">🖨️ 列印 / 存 PDF</button>`;
  const hint = editable
    ? '點下方<b>有課的格子</b>指派代課教師（清單只列該節空堂的老師）；再點一次可更換或清除。'
    : '此為他人填報的代課，僅供檢視。';
  const rangeLbl = fmtSubstScope(rec);
  const dateBtn = editable ? `<button class="ghost" data-action="subst-dates" data-id="${rec.id}">📅 ${rangeLbl ? esc(rangeLbl) : '設定代課日期／節次'}</button>` : (rangeLbl ? `<span class="pill blue">${esc(rangeLbl)}</span>` : '');
  const weekTabs = multi ? `<div class="subst-week-tabs no-print">
      <button class="${substWeekTab == null ? 'active' : ''}" data-action="subst-week-tab" data-w="all">全部週</button>
      ${weeks.map(w => `<button class="${substWeekTab === w.idx ? 'active' : ''}" data-action="subst-week-tab" data-w="${w.idx}">第${w.idx + 1}週<small>${esc(w.start.slice(5))}–${esc(w.end.slice(5))}</small></button>`).join('')}
    </div>
    <div class="hint no-print" style="color:var(--muted);margin:2px 0 10px">${substWeekTab == null
      ? '「<b>全部週</b>」是基礎指派、套用到每一週。若某週的某節要換不同代課老師，切到<b>該週</b>單獨指派（會蓋過全部週；其餘格子仍沿用全部週）。'
      : `目前編輯<b>第${substWeekTab + 1}週</b>（${esc(wk.start)}～${esc(wk.end)}）：在此指派＝<b>本週單獨</b>（蓋過全部週）；未單獨指派的格子沿用全部週。`}</div>` : '';
  const head = subHead(`🔄 代課 — ${esc(t.name)}`, `${dateBtn}${btns}`, 'no-print') +
    `<div class="hint no-print" style="margin-bottom:10px;color:var(--muted)">${hint} ${wk ? `第${substWeekTab + 1}週` : ''}已指派 <b>${done}</b> / 共 <b>${total}</b> 節。</div>`;
  return head + weekTabs + `<div class="card"><div class="card-body"><div class="grid-wrap">${substTimetableHTML(rec, editable, substWeekTab)}</div></div></div>`;
}

function substTimetableHTML(rec, interactive, weekTab = null) {
  const days = activeDays();
  const t = teacherById(rec.absentTeacherId);
  const weeks = substWeeks(rec); const wk = (weekTab != null && weeks[weekTab]) ? weeks[weekTab] : null;
  const wdSet = wk ? weekWeekdays(wk) : substRangeWeekdays(rec);   // v10.09/16 週別鎖定
  const map = {};
  for (const key in state.slots) {
    if (!slotAssignments(key).some(a => a.teacherId === rec.absentTeacherId)) continue;
    const [classId, day, period] = key.split('|');
    (map[day + '|' + period] = map[day + '|' + period] || []).push({ classId, sid: state.slots[key], key });
  }
  const scopeLbl = fmtSubstScope(rec) + (wk ? `　第${weekTab + 1}週 ${wk.start}～${wk.end}` : '');
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc(t.name)} 代課課表${scopeLbl ? '　' + esc(scopeLbl) : ''}</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => { const open = !wdSet || wdSet.has(d); return `<th${open ? '' : ' class="subst-day-off"'}>${DAY_LABELS[d]}${open ? '' : ' 🔒'}</th>`; }).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}</td></tr>`; continue; }
    const perOn = substPeriodOnLeave(rec, p.id);
    html += `<tr><td class="period-th${perOn ? '' : ' subst-day-off'}">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const cellOpen = (!wdSet || wdSet.has(d)) && perOn;
      const hits = map[d + '|' + p.id];
      if (!hits || !hits.length) { html += `<td class="cell${cellOpen ? '' : ' subst-cell-off'}"></td>`; continue; }
      const chips = hits.map(h => {
        const s = subjectById(h.sid); const color = s ? s.color : '#94a3b8';
        const subId = substEffectiveSub(rec, weekTab, h.key);
        const ovr = substHasOverride(rec, weekTab, h.key);   // 本週單獨指派
        const act = (interactive && cellOpen) ? `data-action="subst-cell" data-id="${rec.id}" data-key="${esc(h.key)}" data-day="${d}" data-period="${esc(p.id)}" data-week="${weekTab == null ? 'all' : weekTab}"` : '';
        const lockStyle = cellOpen ? '' : 'opacity:.4;filter:grayscale(.55);cursor:not-allowed;';
        const tail = subId
          ? `<span class="subst-sub">代課：${esc(teacherName(subId))}${ovr ? '（本週）' : (wk ? '（沿用全部週）' : '')}</span>`
          : (cellOpen ? `<span class="subst-need-tag no-print">＋ 指派代課</span>` : `<span class="subst-need-tag no-print">🔒 非代課時段</span>`);
        return `<div class="subst-offer ${subId ? 'assigned' : (cellOpen ? 'need' : 'off')}" ${act} style="background:${color};color:${subjTextColor(s, color)};${lockStyle}">
          <b>${esc((classById(h.classId) || {}).name || '')}</b><small>${esc(subjectName(h.sid))}</small>
          ${tail}
        </div>`;
      }).join('');
      html += `<td class="cell${cellOpen ? '' : ' subst-cell-off'}">${chips}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// v10.06 開始/截止日欄位（新增與編輯共用）
function substDateFieldsHTML(start, end) {
  return `<div style="display:flex;gap:10px;flex-wrap:wrap">
      <label class="field" style="flex:1;min-width:130px"><span>開始日</span><input id="substStart" type="date" value="${esc(start || localDateStr())}"></label>
      <label class="field" style="flex:1;min-width:130px"><span>截止日</span><input id="substEnd" type="date" value="${esc(end || localDateStr())}"></label>
    </div>
    <p class="hint" style="color:var(--muted);margin:6px 0 0">代課在此期間生效：期間內這些課會併入代課老師的課表，影響其他代課可選的空堂人選；截止日一過、或由排課者刪除本筆即失效。</p>`;
}
function readSubstDates() {
  const s = ($('#substStart').value || '').trim(), e = ($('#substEnd').value || '').trim();
  if (!s || !e) { toast('請填寫開始日與截止日'); return null; }
  if (s > e) { toast('截止日不可早於開始日'); return null; }
  return { startDate: s, endDate: e };
}
// v10.13 請假節次選擇（半天/指定節次）：預設全天（全勾）。快速鍵：全天/上午/下午。
function substPeriodFieldsHTML(selected) {
  const nb = lessonPeriods();
  const sel = new Set((Array.isArray(selected) ? selected : []).map(String));
  const allSel = sel.size === 0;   // 空＝全天＝全勾
  const boxes = nb.map(p => `<label class="checkbox chk-inline"><input type="checkbox" class="subst-per-chk" value="${p.id}" ${allSel || sel.has(String(p.id)) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('');
  return `<div class="field" style="margin-top:10px"><span>請假節次（半天／指定節次；預設全天）</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px">
        <button type="button" class="ghost" data-action="subst-per-preset" data-preset="all">全天</button>
        <button type="button" class="ghost" data-action="subst-per-preset" data-preset="am">上午</button>
        <button type="button" class="ghost" data-action="subst-per-preset" data-preset="pm">下午</button>
      </div>
      <div style="display:flex;gap:10px 14px;flex-wrap:wrap">${boxes}</div>
      <p class="hint" style="color:var(--muted);margin:6px 0 0">只勾選部分節次＝半天／指定節次請假；未勾的節次在課表上會鎖定、不需代課。</p></div>`;
}
function readSubstPeriods() {
  const nb = lessonPeriods();
  const checked = [...document.querySelectorAll('.subst-per-chk:checked')].map(el => el.value);
  if (!checked.length) { toast('請至少勾選一個請假節次'); return null; }
  return checked.length === nb.length ? [] : checked;   // 全勾＝全天（存空陣列）
}
function substAddModal() {
  // v10.10 教師 kiosk：被代課者＝登入教師本人，不提供選擇（挑教師只留在排課者主程式），只問日期
  if (substKiosk) {
    if (!substMyTeacherId) { toast('你的帳號不在教師名單，無法新增；請聯絡排課老師'); return; }
    openModal({
      title: '新增我的代課（請假）', saveLabel: '建立',
      body: `<p style="margin-top:0;color:var(--muted)">被代課（請假）教師：<b>${esc(teacherName(substMyTeacherId))}</b>（你本人）</p>${substDateFieldsHTML('', '')}${substPeriodFieldsHTML([])}`,
      onSave: () => {
        const dates = readSubstDates(); if (!dates) return false;
        const periods = readSubstPeriods(); if (!periods) return false;
        const conflict = substLeaveConflict({ id: '', absentTeacherId: substMyTeacherId, startDate: dates.startDate, endDate: dates.endDate, periods });
        if (conflict) { toast(`你在「${fmtSubstScope(conflict)}」已經有一筆代課填報，日期／節次重疊，不能重複建立。請改期，或回上一頁編輯既有那筆。`); return false; }
        const rec = { id: uid(), absentTeacherId: substMyTeacherId, startDate: dates.startDate, endDate: dates.endDate, periods, createdAt: new Date().toISOString(), assignments: {}, createdByEmail: substMyEmail, createdByName: substMyName };
        substEditableIds.add(rec.id);
        state.substitutions.push(rec); save(); substOpenId = rec.id; closeModal(); render(); return true;
      },
    });
    return;
  }
  const tOpts = state.teachers.map(t => `<option value="${t.id}">${esc(t.name)}${t.type ? `（${esc(t.type)}）` : ''}</option>`).join('');
  openModal({
    title: '新增代課', saveLabel: '建立',
    body: `<label class="field" style="margin-bottom:10px"><span>被代課（請假）教師</span><select id="substTeacher">${tOpts}</select></label>
      ${substDateFieldsHTML('', '')}${substPeriodFieldsHTML([])}`,
    onSave: () => {
      const tid = $('#substTeacher').value; if (!tid) { toast('請選擇教師'); return false; }
      const dates = readSubstDates(); if (!dates) return false;
      const periods = readSubstPeriods(); if (!periods) return false;
      const conflict = substLeaveConflict({ id: '', absentTeacherId: tid, startDate: dates.startDate, endDate: dates.endDate, periods });
      if (conflict) { toast(`${teacherName(tid)} 在「${fmtSubstScope(conflict)}」已有代課填報，日期／節次重疊，不能重複建立。若要修改請編輯既有那筆。`); return false; }
      const rec = { id: uid(), absentTeacherId: tid, startDate: dates.startDate, endDate: dates.endDate, periods, createdAt: new Date().toISOString(), assignments: {} };
      state.substitutions.push(rec); save(); substOpenId = rec.id; closeModal(); render(); return true;
    },
  });
}
function substEditDates(recId) {
  const rec = substById(recId); if (!rec) return;
  openModal({
    title: '代課日期／節次', saveLabel: '儲存',
    body: substDateFieldsHTML(rec.startDate, rec.endDate) + substPeriodFieldsHTML(rec.periods),
    onSave: () => {
      const dates = readSubstDates(); if (!dates) return false;
      const periods = readSubstPeriods(); if (!periods) return false;
      const conflict = substLeaveConflict({ id: rec.id, absentTeacherId: rec.absentTeacherId, startDate: dates.startDate, endDate: dates.endDate, periods });
      if (conflict) { toast(`${teacherName(rec.absentTeacherId)} 在「${fmtSubstScope(conflict)}」已有另一筆代課填報，日期／節次重疊。請改期或合併到那一筆。`); return false; }
      rec.startDate = dates.startDate; rec.endDate = dates.endDate; rec.periods = periods; save(); closeModal(); render(); return true;
    },
  });
}

function substCellPicker(recId, key, day, period, weekTab = null) {
  const rec = substById(recId); if (!rec) return;
  const classId = key.split('|')[0]; const sid = state.slots[key];
  const free = freeTeachersAt(day, period, rec, weekTab);
  const cur = substEffectiveSub(rec, weekTab, key);
  const ovr = substHasOverride(rec, weekTab, key);
  const weeks = substWeeks(rec); const wk = (weekTab != null && weeks[weekTab]) ? weeks[weekTab] : null;
  const clsName = (classById(classId) || {}).name || '';
  const perLabel = (state.settings.periods.find(pp => pp.id === period) || {}).label || '';
  const list = free.length
    ? free.map(tt => `<label class="restore-item"><input type="radio" name="subT" value="${tt.id}" ${cur === tt.id ? 'checked' : ''}>
        <span><b>${esc(tt.name)}</b>${tt.type ? ` <small style="color:var(--muted)">${esc(tt.type)}</small>` : ''}</span></label>`).join('')
    : `<p style="color:var(--danger);margin:6px 0">本節沒有空堂教師可代課（其他老師都在上課、設為不排課時段、或正在其他代課／請假中）。</p>`;
  const blocked = substOtherBlockers(day, period, rec);   // v10.06 因日期重疊而不可選者，列出原因
  const blockedHTML = blocked.size
    ? `<div style="margin-top:10px"><p class="hint" style="color:var(--muted);margin:0 0 2px">因日期重疊，本節不可代課：</p>${[...blocked.entries()].map(([tid, reason]) => `<div class="hint" style="color:var(--muted);margin:2px 0">・${esc(reason)}</div>`).join('')}</div>`
    : '';
  const weekNote = wk ? `<p class="hint" style="color:var(--muted);margin:2px 0 8px">指派範圍：<b>第${weekTab + 1}週（${esc(wk.start)}～${esc(wk.end)}）單獨</b>。${ovr ? '目前為本週單獨指派。' : '目前沿用「全部週」的指派。'}</p>` : '';
  const setAssign = v => {
    if (weekTab == null) rec.assignments[key] = v;
    else rec.weekOverrides[weekTab + '|' + key] = v;
  };
  openModal({
    title: `指派代課 — ${clsName} ${subjectName(sid)}`, saveLabel: '確定',
    onSave: free.length ? () => {
      const sel = document.querySelector('input[name="subT"]:checked'); if (!sel) { toast('請選一位代課教師'); return false; }
      setAssign(sel.value); save(); closeModal(); render(); return true;
    } : null,
    body: `<p style="margin-top:0;color:var(--muted)">${DAY_LABELS[day]} ${esc(perLabel)}　被代課：<b>${esc(teacherName(rec.absentTeacherId))}</b>${fmtSubstScope(rec) ? `　<span class="pill blue">${esc(fmtSubstScope(rec))}</span>` : ''}</p>${weekNote}
      <div class="restore-list">${list}</div>${blockedHTML}
      ${(weekTab != null && ovr) ? `<button type="button" class="ghost" data-action="subst-clear-override" data-id="${rec.id}" data-key="${esc(key)}" data-week="${weekTab}" style="margin-top:10px">↩ 改回沿用「全部週」</button>` : ''}
      ${(weekTab == null && cur) ? `<button type="button" class="ghost" data-action="subst-clear" data-id="${rec.id}" data-key="${esc(key)}" style="margin-top:10px">清除此格代課</button>` : ''}`,
  });
}

function substDelete(id) {
  const r = substById(id); if (!r) return;
  const t = teacherById(r.absentTeacherId);
  if (!confirm(`確定刪除「${(t || {}).name || '（已刪除教師）'}」的代課記錄嗎？此動作無法復原。`)) return;
  state.substitutions = state.substitutions.filter(x => x.id !== id);
  if (!Array.isArray(state.substDeleted)) state.substDeleted = [];
  if (!state.substDeleted.includes(id)) state.substDeleted.push(id);   // v10.12 墓碑：收回時不再合併回來
  if (substOpenId === id) substOpenId = null;
  save(); render();
  // 已開放線上填報→線上檔可能還有這筆，提供立即更新線上的選擇
  if (state.substShare) {
    if (confirm('已刪除。線上代課檔可能還留有這筆資料。\n\n要現在就「更新線上代課檔」把刪除推送上去嗎？（同時會收回教師新填的代課）\n\n選「取消」也沒關係：之後按「收回代課」時，系統已會自動略過已刪除的紀錄，不會再合併回來。')) { collectSubst(); return; }
  }
  toast('已刪除代課記錄');
}

// 代課者本人課表（原有課務 + 本次新增的代課節）— 供列印。weekIdx!=null＝該週有效指派
function subTeacherTimetableHTML(subId, rec, weekIdx = null) {
  const days = activeDays();
  const t = teacherById(subId); if (!t) return '';
  const weeks = substWeeks(rec); const wk = (weekIdx != null && weeks[weekIdx]) ? weeks[weekIdx] : null;
  const wdSet = wk ? weekWeekdays(wk) : substRangeWeekdays(rec);
  const own = {};   // day|period → [{classId,sid}]（代課者自己原本的課）
  for (const key in state.slots) {
    if (!slotAssignments(key).some(a => a.teacherId === subId)) continue;
    const [classId, day, period] = key.split('|');
    (own[day + '|' + period] = own[day + '|' + period] || []).push({ classId, sid: state.slots[key] });
  }
  const eff = effAssign(rec, weekIdx);
  const sub = {};   // day|period → [{classId,sid}]（本次指派給此代課者的代課節，限本週範圍）
  for (const key in eff) {
    if (eff[key] !== subId) continue;
    const [classId, day, period] = key.split('|');
    if ((wdSet && !wdSet.has(Number(day))) || !substPeriodOnLeave(rec, period)) continue;
    (sub[day + '|' + period] = sub[day + '|' + period] || []).push({ classId, sid: state.slots[key] });
  }
  const absentName = teacherName(rec.absentTeacherId);
  const wkLbl = wk ? `　第${weekIdx + 1}週 ${wk.start}～${wk.end}` : (fmtSubstScope(rec) ? '　' + fmtSubstScope(rec) : '');
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc(t.name)} 課表（含代課）${esc(wkLbl)}</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const dp = d + '|' + p.id;
      const oh = own[dp], sh = sub[dp];
      if (oh && oh.length) {
        const s = subjectById(oh[0].sid); const color = s ? s.color : '#94a3b8';
        const label = oh.map(h => (classById(h.classId) || {}).name || '').join('、');
        html += `<td class="cell"><div class="cell-lesson" style="background:${color};color:${subjTextColor(s, color)}">${esc(label)}<small>${esc(subjectName(oh[0].sid))}</small></div></td>`;
      } else if (sh && sh.length) {
        const s = subjectById(sh[0].sid); const color = s ? s.color : '#94a3b8';
        const label = sh.map(h => (classById(h.classId) || {}).name || '').join('、');
        html += `<td class="cell"><div class="subst-offer assigned" style="background:${color};color:${subjTextColor(s, color)}">
          <b>${esc(label)}</b><small>${esc(subjectName(sh[0].sid))}</small>
          <span class="subst-sub">代課（代 ${esc(absentName)}）</span></div></td>`;
      } else html += `<td class="cell"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// 受影響班級的班級課表（代課節改顯示代課教師名）— 供列印。weekIdx!=null＝該週有效指派
function substClassTimetableHTML(classId, rec, weekIdx = null) {
  const days = activeDays(); const c = classById(classId); const g = classGrade(c);
  const weeks = substWeeks(rec); const wk = (weekIdx != null && weeks[weekIdx]) ? weeks[weekIdx] : null;
  const wdSet = wk ? weekWeekdays(wk) : substRangeWeekdays(rec);
  const eff = effAssign(rec, weekIdx);
  const wkLbl = wk ? `　第${weekIdx + 1}週 ${wk.start}～${wk.end}` : (fmtSubstScope(rec) ? '　' + fmtSubstScope(rec) : '');
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc((c || {}).name || '')} 課表（代課後）${esc(wkLbl)}</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}　${esc(p.start)}–${esc(p.end)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const key = slotKey(classId, d, p.id); const sid = state.slots[key];
      const open = g && gradePeriodHasDay(g, p.id, d);
      if (sid) {
        const s = subjectById(sid); const color = s ? s.color : '#94a3b8';
        const inScope = (!wdSet || wdSet.has(d)) && substPeriodOnLeave(rec, p.id);
        const subId = inScope ? eff[key] : null;   // v10.16 只在本週範圍內顯示代課
        const room = roomsLabelCS(classId, sid) ? '·' + roomsLabelCS(classId, sid) : '';
        if (subId) {   // 此節被代課：改顯示代課教師名
          html += `<td class="cell"><div class="subst-offer assigned" style="background:${color};color:${subjTextColor(s, color)}" title="原任課：${esc(slotTeachersLabel(key))}">
            <b>${esc(subjectName(sid))}</b>
            <span class="subst-sub">${esc(teacherName(subId))}</span></div></td>`;
        } else {
          html += `<td class="cell"><div class="cell-lesson" style="background:${color};color:${subjTextColor(s, color)}">${esc(subjectName(sid))}<small>${esc(slotTeachersLabel(key))}${esc(room)}</small></div></td>`;
        }
      } else if (open) { html += `<td class="cell"></td>`; }
      else { html += `<td class="cell blocked" title="此節本日不上課"></td>`; }
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// 組合列印內容：被代課者代課課表 + 每位代課者的課表（含代課）+ 受影響班級課表（代課節改教師名）
// v10.16 多週記錄：逐週各出一組（週標題＋該週有效指派）。
function substPrintHTML(rec) {
  const weeks = substWeeks(rec);
  const parts = weeks.length > 1 ? weeks.map(w => w.idx) : [null];
  let html = '';
  for (const wi of parts) {
    if (wi != null) html += `<div class="subst-print-page"><div style="text-align:center;font-weight:800;font-size:18px;margin:6px 0 10px">第${wi + 1}週（${esc(weeks[wi].start)}～${esc(weeks[wi].end)}）</div>${substTimetableHTML(rec, false, wi)}</div>`;
    else html += `<div class="subst-print-page">${substTimetableHTML(rec, false, null)}</div>`;
    const eff = effAssign(rec, wi);
    const subIds = [...new Set(Object.values(eff).filter(Boolean))];
    for (const sid of subIds) html += `<div class="subst-print-page">${subTeacherTimetableHTML(sid, rec, wi)}</div>`;
    const setKeys = Object.keys(eff).filter(k => eff[k]);
    const affected = state.classes.filter(c => setKeys.some(k => k.split('|')[0] === c.id));
    for (const c of affected) html += `<div class="subst-print-page">${substClassTimetableHTML(c.id, rec, wi)}</div>`;
  }
  return html;
}

function substPrint() {
  const rec = substById(substOpenId); if (!rec) return;
  const any = Object.values(rec.assignments || {}).some(Boolean) || Object.values(rec.weekOverrides || {}).some(Boolean);   // v10.16 含分週覆蓋
  if (!any) { toast('尚未指派任何代課，無可列印內容'); return; }
  const area = document.createElement('div');
  area.className = 'subst-print-area';
  area.innerHTML = substPrintHTML(rec);
  document.body.appendChild(area);
  document.body.classList.add('printing-subst');
  const cleanup = () => { document.body.classList.remove('printing-subst'); area.remove(); };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 2000);
}

/* ---------- v10.14（A4）代課老師「跨紀錄合併總表」 ---------- */
// 所有代課紀錄中被指派過的代課教師 id（依教師名單順序；含分週覆蓋）
function substituteTeacherIds() {
  const ids = new Set();
  for (const rec of (state.substitutions || [])) {
    for (const k in (rec.assignments || {})) if (rec.assignments[k]) ids.add(rec.assignments[k]);
    for (const k in (rec.weekOverrides || {})) if (rec.weekOverrides[k]) ids.add(rec.weekOverrides[k]);
  }
  return state.teachers.filter(t => ids.has(t.id)).map(t => t.id);
}
// 一位代課老師橫跨所有紀錄的合併課表：灰底＝本人原課、彩色＝代課（標「代 ○○（日期/節次）」）
function subTeacherMergedTimetableHTML(subId) {
  const days = activeDays();
  const t = teacherById(subId); if (!t) return '';
  const own = {};   // day|period → [{classId,sid}]
  for (const key in state.slots) {
    if (!slotAssignments(key).some(a => a.teacherId === subId)) continue;
    const [classId, day, period] = key.split('|');
    (own[day + '|' + period] = own[day + '|' + period] || []).push({ classId, sid: state.slots[key] });
  }
  // v10.18 連續同代課老師的週合併成一段日期（避免整學期代課逐週爆長）
  const sub = {};   // day|period → [{classId,sid,absent,scope}]
  let cnt = 0;      // 總代課節數（週×格 展開計）
  for (const rec of (state.substitutions || [])) {
    const weeks = substWeeks(rec); const absent = teacherName(rec.absentTeacherId);
    if (weeks.length <= 1) {
      const eff = effAssign(rec, null);
      for (const key in eff) {
        if (eff[key] !== subId || !substCellInScope(rec, key)) continue;
        const [classId, day, period] = key.split('|');
        (sub[day + '|' + period] = sub[day + '|' + period] || []).push({ classId, sid: state.slots[key], absent, scope: fmtSubstScope(rec) }); cnt++;
      }
    } else {
      // 候選格＝底指派 + 分週覆蓋的 key（去 W 前綴）
      const keys = new Set(Object.keys(rec.assignments || {}));
      for (const k in (rec.weekOverrides || {})) keys.add(k.split('|').slice(1).join('|'));
      for (const key of keys) {
        const [classId, day, period] = key.split('|');
        if (!substPeriodOnLeave(rec, period)) continue;
        const applies = weeks.filter(w => weekWeekdays(w).has(Number(day)) && substEffectiveSub(rec, w.idx, key) === subId).map(w => w.idx);
        if (!applies.length) continue;
        cnt += applies.length;
        // 連續週 index 併成 run
        const runs = []; let run = [applies[0]];
        for (let i = 1; i < applies.length; i++) { if (applies[i] === applies[i - 1] + 1) run.push(applies[i]); else { runs.push(run); run = [applies[i]]; } }
        runs.push(run);
        for (const r of runs) {
          const scope = `${weeks[r[0]].start}～${weeks[r[r.length - 1]].end}`;
          (sub[day + '|' + period] = sub[day + '|' + period] || []).push({ classId, sid: state.slots[key], absent, scope });
        }
      }
    }
  }
  let html = `<div style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc(t.name)} 代課合併總表<span style="font-weight:400;font-size:13px;color:#64748b">（代課 ${cnt} 節）</span></div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (p.isBreak) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const dp = d + '|' + p.id; const oh = own[dp], sh = sub[dp];
      if (sh && sh.length) {
        const chips = sh.map(h => {
          const s = subjectById(h.sid); const color = s ? s.color : '#94a3b8';
          return `<div class="subst-offer assigned" style="background:${color};color:${subjTextColor(s, color)}">
            <b>${esc((classById(h.classId) || {}).name || '')}</b><small>${esc(subjectName(h.sid))}</small>
            <span class="subst-sub">代 ${esc(h.absent)}${h.scope ? '（' + esc(h.scope) + '）' : ''}</span></div>`;
        }).join('');
        html += `<td class="cell">${chips}</td>`;
      } else if (oh && oh.length) {
        const s = subjectById(oh[0].sid); const color = s ? s.color : '#94a3b8';
        const label = oh.map(h => (classById(h.classId) || {}).name || '').join('、');
        html += `<td class="cell"><div class="cell-lesson" style="background:${color};color:${subjTextColor(s, color)};opacity:.6">${esc(label)}<small>${esc(subjectName(oh[0].sid))}</small></div></td>`;
      } else html += `<td class="cell"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}
function substSubMasterModal() {
  const ids = substituteTeacherIds();
  if (!ids.length) { toast('目前沒有任何已指派的代課'); return; }
  const body = `<p style="margin-top:0;color:var(--muted)">每位代課老師在<b>所有代課紀錄</b>中的代課，合併成一張課表（灰底＝本人原有課、彩色＝代課並標「代 ○○（日期/節次）」）。不同紀錄若落在同一格會並列。</p>`
    + ids.map(id => `<div style="margin:16px 0"><div class="grid-wrap">${subTeacherMergedTimetableHTML(id)}</div></div>`).join('')
    + `<div style="margin-top:12px"><button class="btn" data-action="subst-submaster-print">🖨️ 列印 / 存 PDF（每位一頁）</button></div>`;
  openModal({ title: '🧑‍🏫 代課老師合併總表', wide: true, body });
}
function substSubMasterPrint() {
  const ids = substituteTeacherIds();
  if (!ids.length) { toast('目前沒有任何已指派的代課'); return; }
  closeModal();   // v10.15 先關 modal，否則列印時 modal(未被 printing-subst 隱藏)會蓋過分頁的 print-area
  const area = document.createElement('div'); area.className = 'subst-print-area';
  area.innerHTML = ids.map(id => `<div class="subst-print-page">${subTeacherMergedTimetableHTML(id)}</div>`).join('');
  document.body.appendChild(area); document.body.classList.add('printing-subst');
  const cleanup = () => { document.body.classList.remove('printing-subst'); area.remove(); };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print(); setTimeout(cleanup, 2000);
}

/* ---------- 代課線上填報（v10.01，網域共享；比照 F③：排課者開放/收回、教師 kiosk 只可新增） ---------- */
const SUBST_FMT = 'course-subst-1';
// 給共享檔的狀態快照（教師 kiosk 端當作 state 直接跑既有代課功能；不含任何憑證，state 本就無機密）
function substContextState() {
  return {
    schema: SCHEMA,
    settings: { periods: state.settings.periods, days: state.settings.days, reportYear: state.settings.reportYear || '', schoolCode: state.settings.schoolCode || '', subjectMap: state.settings.subjectMap || {}, maxLessonsPerDay: state.settings.maxLessonsPerDay || 0 },
    subjects: state.subjects, grades: state.grades, classes: state.classes, teachers: state.teachers, rooms: state.rooms || [],
    domains: state.domains || [], slots: state.slots, slotTeachers: state.slotTeachers, slotContent: state.slotContent || {},
    substitutions: state.substitutions || [],
  };
}
// 排課者：開放（建根目錄檔＋網域共享）
async function openSubstShare() {
  if (!Array.isArray(state.substitutions)) state.substitutions = [];
  normalizeAllSubst();
  // v10.04 逐位 email 分享（學校帳號＋個人 Gmail 皆通用；免網域，免後端）
  const withEmail = state.teachers.filter(t => t.email && /@/.test(t.email));
  if (!withEmail.length) { toast('尚無教師填 Email。請到「③ 教師」為要參與代課填報的老師填 Google Email（學校或 Gmail 皆可）。'); return; }
  let step = '連線 Google';
  try {
    toast('連線 Google…'); await getFillToken('');
    const year = String(state.settings.reportYear || '');
    const payload = { fmt: SUBST_FMT, ver: 1, openedAt: new Date().toISOString(), state: substContextState() };
    step = '建立雲端檔案';
    const f = await drivePutJson(`代課填報-${state.settings.schoolCode || 'msd9'}${year}.json`, null, JSON.stringify(payload));
    const shared = [], failed = [];
    for (const t of withEmail) {
      step = `分享給 ${t.email}`;
      try { await driveShare(f.id, t.email); shared.push(t.email); }
      catch (e) { failed.push(t.email + '（' + ((e && e.message) || '失敗').slice(0, 60) + '）'); }
    }
    state.substShare = { fileId: f.id, link: f.webViewLink || '', sharedEmails: shared, openedAt: new Date().toISOString() };
    save(); render(); substShareModal();
    if (failed.length) openModal({ title: '已開放（部分分享失敗）', body: `<p style="margin-top:0">已分享給 <b>${shared.length}</b> 位；<b>${failed.length}</b> 位失敗：</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:10px;border-radius:8px;font-size:12px">${esc(failed.join('\n'))}</pre>` });
    else toast('已開放代課填報，已分享給 ' + shared.length + ' 位教師');
  } catch (e) {
    openModal({ title: '開放失敗', body: `<p style="margin-top:0">在步驟「<b>${esc(step)}</b>」發生錯誤：</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:10px;border-radius:8px;font-size:12px">${esc((e && e.message) || String(e))}</pre><p style="color:var(--muted);font-size:12px">請把這段訊息回報，以便對症。</p>` });
  }
}
// 排課者：收回（把教師新增的代課合併回本機，只增不覆蓋）→ 接著重新開放：
//   用目前課表快照「覆蓋」共享檔（已收回的代課含在快照裡故保留）＋補分享給新填 Email 的教師。
// v10.08：收回與重新開放合一。先收回可確保覆蓋前教師填報都已進本機，覆蓋不會遺失。
async function collectSubst() {
  if (!state.substShare) { return openSubstShare(); }   // 尚未開放 → 直接開放
  normalizeAllSubst();
  const withEmail = state.teachers.filter(t => t.email && /@/.test(t.email));
  let step = '連線 Google';
  try {
    toast('連線 Google…'); await getFillToken('');
    // 1) 收回合併（只增不覆蓋本機既有）
    step = '讀取教師填報';
    if (!Array.isArray(state.substDeleted)) state.substDeleted = [];
    const deleted = new Set(state.substDeleted);
    let added = 0;
    try {
      const obj = JSON.parse(await fillDownloadText(state.substShare.fileId));
      const incoming = (obj.state && Array.isArray(obj.state.substitutions)) ? obj.state.substitutions : [];
      const localIds = new Set((state.substitutions || []).map(r => r.id));
      // v10.12 略過墓碑：排課者已刪除的紀錄不再合併回來（避免線上殘留被再度收回）
      incoming.forEach(r => { if (r && r.id && !localIds.has(r.id) && !deleted.has(r.id)) { state.substitutions.push(r); added++; } });
      normalizeAllSubst();
    } catch (e) { /* 舊檔讀不到(可能被刪)→視為無新填報，下面改建新檔 */ }
    // 1.5) v10.12 檢查已合併記錄是否過期，讓排課者確認刪除（會一併從線上檔移除）
    let removedExpired = 0;
    const expired = (state.substitutions || []).filter(substExpired);
    if (expired.length) {
      const lines = expired.map(r => `・${teacherName(r.absentTeacherId)}（${fmtSubstRange(r) || '無日期'}）`).join('\n');
      if (confirm(`偵測到 ${expired.length} 筆代課記錄截止日已過：\n\n${lines}\n\n要一併刪除這些過期記錄嗎？（會從系統與線上代課檔一起移除；選「取消」則保留）`)) {
        const exIds = new Set(expired.map(r => r.id));
        state.substitutions = state.substitutions.filter(r => !exIds.has(r.id));
        exIds.forEach(id => { if (!state.substDeleted.includes(id)) state.substDeleted.push(id); });
        if (substOpenId && exIds.has(substOpenId)) substOpenId = null;
        removedExpired = expired.length;
      }
    }
    // 2) 用最新快照覆蓋共享檔（保留已收回的代課；同時把課表更新推給教師端）
    step = '更新共享檔快照';
    const year = String(state.settings.reportYear || '');
    const payload = { fmt: SUBST_FMT, ver: 1, openedAt: new Date().toISOString(), state: substContextState() };
    let fileId = state.substShare.fileId, link = state.substShare.link || '';
    try {
      const f = await drivePutJson('', null, JSON.stringify(payload), fileId);   // PATCH 覆蓋既有檔
      fileId = f.id; link = f.webViewLink || link;
    } catch (e) {
      const f = await drivePutJson(`代課填報-${state.settings.schoolCode || 'msd9'}${year}.json`, null, JSON.stringify(payload));   // 舊檔失效→建新檔
      fileId = f.id; link = f.webViewLink || '';
    }
    // 3) 補分享給尚未分享過的 Email（新加入的教師/臨時代課老師）
    const already = new Set(state.substShare.sharedEmails || []);
    const shared = [...already], failed = []; let newShared = 0;
    for (const t of withEmail) {
      if (already.has(t.email)) continue;
      step = `分享給 ${t.email}`;
      try { await driveShare(fileId, t.email); shared.push(t.email); newShared++; }
      catch (e) { failed.push(t.email + '（' + ((e && e.message) || '失敗').slice(0, 60) + '）'); }
    }
    state.substShare = { fileId, link, sharedEmails: shared, openedAt: new Date().toISOString() };
    save(); render(); substShareModal();
    let msg = (added ? `已收回 ${added} 筆教師填報，` : '無新填報，') + '已用最新課表更新共享檔（含推送刪除）' + (removedExpired ? `，清除 ${removedExpired} 筆過期` : '') + (newShared ? `，補分享給 ${newShared} 位新教師` : '');
    if (failed.length) openModal({ title: '已收回並重新開放（部分分享失敗）', body: `<p style="margin-top:0">${esc(msg)}。以下分享失敗：</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:10px;border-radius:8px;font-size:12px">${esc(failed.join('\n'))}</pre>` });
    else toast(msg);
  } catch (e) {
    openModal({ title: '收回／重新開放失敗', body: `<p style="margin-top:0">在步驟「<b>${esc(step)}</b>」發生錯誤：</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:10px;border-radius:8px;font-size:12px">${esc((e && e.message) || String(e))}</pre>` });
  }
}
function substShareModal() {
  const ss = state.substShare;
  const url = location.origin + location.pathname + '?subst=1';
  const withEmail = state.teachers.filter(t => t.email && /@/.test(t.email));
  const shareCount = ss && ss.sharedEmails ? ss.sharedEmails.length : 0;
  const body = ss
    ? `<div class="total-badge ok">已開放 · 已分享給 ${shareCount} 位教師</div>
       <p style="margin:8px 0"><b>把這個代課填報連結給教師：</b><br><code style="user-select:all;word-break:break-all">${esc(url)}</code></p>
       <p style="color:var(--muted);margin:8px 0">教師用<b>自己的 Google 帳號（學校或 Gmail 皆可）</b>登入 → Picker 選這份代課檔 → 看全部代課、可<b>新增自己的</b>（不可刪改他人）。<b>新增了教師（或臨時代課老師）→ 在③教師補其 Email → 按下方「收回代課」即會補分享給新加入者。</b></p>
       <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
         <button class="btn" data-action="collect-subst">📥 收回代課（合併＋更新線上）</button>
       </div>
       <p class="hint" style="color:var(--muted);margin:8px 0 0">「收回代課」會：把教師新填的代課合併回來 → 用<b>目前最新課表</b>覆蓋共享檔（已收回的代課保留、課表更新同步給教師端、<b>你刪除過的代課會一併從線上移除且不再合併回來</b>）→ <b>若有截止日已過的代課會先問你要不要清除</b> → 補分享給新填 Email 的教師。</p>`
    : `<p style="margin-top:0">在你的雲端硬碟建立一份「代課填報」共享檔（含目前課表快照），<b>逐位分享給有填 Email 的教師</b>（學校帳號或個人 Gmail 皆可）；教師用連結登入查看全部代課、<b>新增</b>自己的代課安排，你再「收回」合併回來。</p>
       <p style="color:var(--muted)">目前有 Email 的教師：<b>${withEmail.length}</b> 位。無校帳號的臨時代課老師，用個人 Gmail 也可以（在③教師填其 Gmail）。教師端<b>只能新增</b>、不能刪改他人；刪除代課仍只由你在此頁做。</p>
       <button class="btn" data-action="open-subst">☁️ 開放代課填報（分享給 ${withEmail.length} 位）</button>`;
  openModal({ title: '線上代課填報（逐位 Email 分享）', wide: true, body });
}
// 教師 kiosk：登入 → Picker 開共享代課檔 → 載入為 state
async function substKioskStart() {
  try {
    toast('登入 Google…'); const token = await getFillToken('');
    const info = await fillUserInfo(); substMyEmail = (info.email || '').trim(); substMyName = info.name || '';
    const fileId = await pickFillFile(token);
    if (!fileId) return;
    const obj = JSON.parse(await fillDownloadText(fileId));
    if (obj.fmt !== SUBST_FMT || !obj.state) { toast('這不是代課填報檔'); return; }
    substFileId = fileId; state = obj.state;
    if (!Array.isArray(state.substitutions)) state.substitutions = [];
    normalizeAllSubst();
    if (!state.settings) state.settings = { periods: [], days: [1, 2, 3, 4, 5] };
    substEditableIds = new Set(); substOpenId = null;
    // v10.10 自助：用登入 email 對應教師本人。挑選被代課教師的權限只留在排課者主程式；
    // 教師端只安排「自己」的代課（自己＝被代課/請假者）。
    const em = (substMyEmail || '').trim().toLowerCase();
    const me = em ? state.teachers.find(t => (t.email || '').trim().toLowerCase() === em) : null;
    substMyTeacherId = me ? me.id : '';
    substNoMatch = !me;
    if (me) {
      // 自己先前送出過的紀錄→可續編、可重送
      state.substitutions.forEach(r => { if (r && (r.createdByEmail || '').trim().toLowerCase() === em) substEditableIds.add(r.id); });
    }
    // v10.10 一律先顯示「我的代課」清單，不自動開啟某一筆——不同日期的請假各自成一筆，
    // 避免在既有那筆上改日期重送而覆蓋（原 auto-open 造成「只保留一筆」）。
    substOpenId = null;
    render();
    if (me && !state.substitutions.some(r => r.absentTeacherId === me.id)) substAddModal();   // 首次無紀錄→引導設定請假日期
  } catch (e) { toast('開啟失敗：' + e.message); }
}
// 教師 kiosk：送出「自己新增的」一筆到雲端（重讀最新、只 upsert 自己這筆，不動他人）
async function substSubmit(rec) {
  if (!rec) return;
  try {
    toast('送出中…');
    let obj; try { obj = JSON.parse(await fillDownloadText(substFileId)); } catch (e) { obj = { fmt: SUBST_FMT, ver: 1, state: { substitutions: [] } }; }
    obj.state = obj.state || {}; const list = Array.isArray(obj.state.substitutions) ? obj.state.substitutions : [];
    const clean = { ...rec, createdByEmail: substMyEmail, createdByName: substMyName };
    const i = list.findIndex(x => x.id === rec.id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    obj.state.substitutions = list;
    await drivePutJson('', null, JSON.stringify(obj), substFileId);
    render();   // v10.10 送出後保留可編輯／停留在本人課表，之後可再調整再送出
    toast('已送出到雲端，排課老師收回後即生效（可再調整後重送）');
  } catch (e) { toast('送出失敗：' + e.message); }
}
function viewSubstKiosk() {
  if (substEnded) return `<div class="card"><div class="card-body" style="text-align:center;padding:48px 20px">
      <h2 style="margin-top:0">✅ 代課填報已結束</h2><p style="color:var(--muted)">你可以直接關閉此分頁。</p></div></div>`;
  if (!substFileId) return `<div class="page-head"><h2>🔄 線上代課填報</h2></div>
    <div class="card"><div class="card-body">
      <p>用<b>你自己的 Google 帳號</b>（學校或 Gmail 皆可）登入，開啟排課老師分享的代課填報檔。系統會以你的帳號 Email 對應你本人，直接調出<b>你自己的課表</b>，讓你為請假期間的課安排代課。</p>
      <button class="btn" data-action="subst-login">用 Google 登入並開啟</button></div></div>`;
  const banner = `<div class="lock-banner no-print"><span>🔄 我的代課填報｜${esc(substMyName || substMyEmail || '')}</span>
      <button class="ghost" data-action="subst-kiosk-exit">完成／關閉</button></div>`;
  if (substNoMatch) return banner + `<div class="card"><div class="card-body" style="text-align:center;padding:40px 20px">
      <h3 style="margin-top:0">找不到你的教師資料</h3>
      <p style="color:var(--muted)">你登入的帳號 <b>${esc(substMyEmail || '')}</b> 不在教師名單中，無法對應到你的課表。<br>請聯絡排課老師，到「③ 教師」把<b>這個 Email</b> 填到你的教師資料後，再重新開啟此連結。</p></div></div>`;
  return banner + viewSubst();
}

// v09.18 班級簡稱：去掉「年級／年／班」，如 六年忠班→六忠、一年甲班→一甲（教師總表格內用）
function classShortName(c) {
  const n = (c && c.name) || '';
  return n.replace(/年級|年|班/g, '') || n;
}
// v09.12/17 全校總表資料模型：kind='school'（各班）｜'schoolTeacher'（各教師）。列＝星期×節次、欄＝各班/各師。
// cellFor(day, pid, i) → {blocked:true}｜null(空)｜{text,color,title}。班級版與教師版共用 HTML/PNG 產生器。
function masterModel(kind) {
  const days = activeDays(); const lessons = state.settings.periods.filter(p => !p.isBreak);
  const school = state.settings.reportSchool || '', year = state.settings.reportYear || '';
  if (!lessons.length) return { ok: false, msg: '尚未設定上課節次。' };
  if (kind === 'schoolTeacher') {
    const teachers = state.teachers;
    if (!teachers.length) return { ok: false, msg: '尚無教師。' };
    const teaches = {}; teachers.forEach(t => teaches[t.id] = new Set((t.load || []).map(L => L.classId + '|' + L.subjectId)));
    const tmap = {}; teachers.forEach(t => tmap[t.id] = {});   // teacherId → {day|period → [{classId,sid}]}
    for (const key in state.slots) {
      const sid = state.slots[key]; const [classId, day, period] = key.split('|'); const s = subjectById(sid); const dp = day + '|' + period;
      teachers.forEach(t => {
        if (!teaches[t.id].has(classId + '|' + sid)) return;
        if (s && s.splitTeachers && state.slotTeachers[key] !== t.id) return;   // 分節：只算該師實際上的節
        (tmap[t.id][dp] = tmap[t.id][dp] || []).push({ classId, sid });
      });
    }
    return {
      ok: true, days, lessons,
      title: `${school}　${year}學年度　教師課表總表`, fileTitle: `全校教師總表_${year}`,
      cols: teachers.map(t => t.name),
      cellFor(day, pid, i) {
        const hits = tmap[teachers[i].id][day + '|' + pid]; if (!hits || !hits.length) return null;
        const s = subjectById(hits[0].sid); const color = s ? s.color : '#94a3b8';
        const classes = hits.map(h => classShortName(classById(h.classId))).join('、');   // 班級簡稱（六年忠班→六忠）
        const subj = subjectName(hits[0].sid);
        return { text: classes + ' ' + subj, color, textColor: subjTextColor(s, color), title: classes + '｜' + subj };
      },
    };
  }
  const classes = sortedClasses();
  if (!classes.length) return { ok: false, msg: '尚無班級。' };
  return {
    ok: true, days, lessons,
    title: `${school}　${year}學年度　課表總表`, fileTitle: `全校課表總表_${year}`,
    cols: classes.map(c => c.name),
    cellFor(day, pid, i) {
      const c = classes[i]; const g = classGrade(c);
      if (!(g && gradePeriodHasDay(g, pid, day))) return { blocked: true };
      const key = slotKey(c.id, day, pid); const sid = state.slots[key]; if (!sid) return null;
      const s = subjectById(sid); const color = s ? s.color : '#94a3b8';
      return { text: subjectName(sid), color, textColor: subjTextColor(s, color), title: slotTeachersLabel(key) };
    },
  };
}
function masterTableHTML(kind) {
  const m = masterModel(kind);
  if (!m.ok) return `<div class="empty">${esc(m.msg)}</div>`;
  const { days, lessons, cols } = m;
  let html = `<div class="master-title">${esc(m.title)}</div>`;
  html += `<table class="master"><thead><tr><th class="mcorner">星期</th><th class="mcorner">節次</th>${cols.map(n => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>`;
  days.forEach(d => {
    lessons.forEach((p, pi) => {
      html += `<tr${pi === 0 ? ' class="mday-first"' : ''}>`;
      if (pi === 0) html += `<td class="mday" rowspan="${lessons.length}">${DAY_LABELS[d]}</td>`;
      html += `<td class="mperiod">${esc(p.label)}</td>`;
      cols.forEach((n, i) => {
        const cell = m.cellFor(d, p.id, i);
        if (cell && cell.blocked) { html += `<td class="mblocked"></td>`; return; }
        if (!cell) { html += `<td></td>`; return; }
        html += `<td class="mcell" style="background:${cell.color};color:${cell.textColor || textOn(cell.color)}" title="${esc(cell.title || '')}">${esc(cell.text)}</td>`;
      });
      html += `</tr>`;
    });
  });
  html += `</tbody></table>`;
  return html;
}
// 全校總表輸出 PNG（純 Canvas 繪製，無外部相依）；班級/教師版共用
function masterPNG(kind) {
  const m = masterModel(kind);
  if (!m.ok) { toast(m.msg); return; }
  const { days, lessons, cols } = m;
  const sc = 2;                                             // hi-dpi 倍率
  const dayW = 40, perW = 62, colW = 88, rowH = 32, headH = 38, titleH = 48, pad = 12;
  const nCols = cols.length, bodyRows = days.length * lessons.length;
  const gridW = dayW + perW + colW * nCols, gridH = headH + rowH * bodyRows;
  const W = gridW + pad * 2, H = titleH + gridH + pad * 2;
  const cv = document.createElement('canvas'); cv.width = W * sc; cv.height = H * sc;
  const ctx = cv.getContext('2d'); ctx.scale(sc, sc);
  const FONT = '"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0f172a'; ctx.font = `bold 20px ${FONT}`;
  ctx.fillText(m.title, W / 2, pad + titleH / 2);
  const ox = pad, oy = pad + titleH;                       // 表格左上
  ctx.fillStyle = '#f1f5f9'; ctx.fillRect(ox, oy, gridW, headH);   // 表頭
  ctx.fillStyle = '#334155'; ctx.font = `bold 13px ${FONT}`;
  ctx.fillText('星期', ox + dayW / 2, oy + headH / 2);
  ctx.fillText('節次', ox + dayW + perW / 2, oy + headH / 2);
  cols.forEach((n, i) => ctx.fillText(n, ox + dayW + perW + colW * i + colW / 2, oy + headH / 2));
  let y = oy + headH;                                       // 內容
  days.forEach(d => {
    const dayTop = y;
    lessons.forEach(p => {
      ctx.fillStyle = '#f8fafc'; ctx.fillRect(ox + dayW, y, perW, rowH);
      ctx.fillStyle = '#334155'; ctx.font = `12px ${FONT}`;
      ctx.fillText(p.label, ox + dayW + perW / 2, y + rowH / 2);
      cols.forEach((n, i) => {
        const x = ox + dayW + perW + colW * i; const cell = m.cellFor(d, p.id, i);
        if (cell && cell.blocked) { ctx.fillStyle = '#eef2f7'; ctx.fillRect(x, y, colW, rowH); }
        else if (cell) {
          ctx.fillStyle = cell.color; ctx.fillRect(x, y, colW, rowH);
          ctx.fillStyle = cell.textColor || textOn(cell.color); ctx.font = `12px ${FONT}`;
          ctx.fillText(cell.text, x + colW / 2, y + rowH / 2);
        }
      });
      y += rowH;
    });
    ctx.fillStyle = '#eff6ff'; ctx.fillRect(ox, dayTop, dayW, y - dayTop);
    ctx.fillStyle = '#1e3a8a'; ctx.font = `bold 14px ${FONT}`;
    ctx.fillText(DAY_LABELS[d], ox + dayW / 2, (dayTop + y) / 2);
  });
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.beginPath();   // 格線
  const xs = [ox, ox + dayW, ox + dayW + perW]; for (let i = 0; i <= nCols; i++) xs.push(ox + dayW + perW + colW * i);
  xs.forEach(x => { ctx.moveTo(x + 0.5, oy); ctx.lineTo(x + 0.5, oy + gridH); });
  ctx.moveTo(ox, oy + 0.5); ctx.lineTo(ox + gridW, oy + 0.5);
  ctx.moveTo(ox, oy + headH + 0.5); ctx.lineTo(ox + gridW, oy + headH + 0.5);
  for (let r = 1; r <= bodyRows; r++) { const yy = oy + headH + rowH * r; ctx.moveTo(ox + dayW, yy + 0.5); ctx.lineTo(ox + gridW, yy + 0.5); }
  days.forEach((d, di) => { const yy = oy + headH + rowH * lessons.length * di; ctx.moveTo(ox, yy + 0.5); ctx.lineTo(ox + gridW, yy + 0.5); });
  const yEnd = oy + gridH; ctx.moveTo(ox, yEnd + 0.5); ctx.lineTo(ox + gridW, yEnd + 0.5);
  ctx.stroke();
  cv.toBlob(blob => {
    if (!blob) { toast('產生 PNG 失敗'); return; }
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${m.fileTitle}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已下載 PNG');
  }, 'image/png');
}
function exportCSV() {
  const days = activeDays(); const rows = [['節次', ...days.map(d => DAY_LABELS[d])]]; let title = '';
  if (outputMode === 'class') {
    title = (classById(outputClassId) || {}).name || '班級';
    for (const p of state.settings.periods) {
      if (p.isBreak) continue;
      rows.push([p.label, ...days.map(d => { const k = slotKey(outputClassId, d, p.id); const sid = state.slots[k]; return sid ? `${subjectName(sid)}/${slotTeachersLabel(k)}` : ''; })]);
    }
  } else {
    title = (teacherById(outputTeacherId) || {}).name || '教師'; const t = teacherById(outputTeacherId);
    const teaches = new Set((t.load || []).map(L => L.classId + '|' + L.subjectId)); const map = {};
    for (const key in state.slots) { const sid = state.slots[key]; const [classId, day, period] = key.split('|'); if (!teaches.has(classId + '|' + sid)) continue; const s = subjectById(sid); if (s && s.splitTeachers && state.slotTeachers[key] !== outputTeacherId) continue; const dp = day + '|' + period; map[dp] = (map[dp] ? map[dp] + '、' : '') + `${(classById(classId) || {}).name || ''}/${subjectName(sid)}`; }
    for (const p of state.settings.periods) { if (p.isBreak) continue; rows.push([p.label, ...days.map(d => map[d + '|' + p.id] || '')]); }
  }
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob(csv, `課表_${title}.csv`, 'text/csv;charset=utf-8'); toast('已匯出 CSV');
}
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function reportOpts() { return { school: state.settings.reportSchool, year: state.settings.reportYear, subjectMap: state.settings.subjectMap }; }
function exportAllClassDocx() {
  if (!state.classes.length) { toast('尚無班級'); return; }
  if (typeof DocxGen === 'undefined') { toast('輸出模組未載入'); return; }
  try { downloadBlob(DocxGen.build(state, reportOpts()).classesDocx(), '所有班級課表.docx', DOCX_MIME); toast(`已輸出 ${state.classes.length} 班課表`); }
  catch (e) { console.error(e); toast('輸出失敗：' + e.message); }
}
function exportAllTeacherDocx() {
  if (!state.teachers.length) { toast('尚無教師'); return; }
  if (typeof DocxGen === 'undefined') { toast('輸出模組未載入'); return; }
  try { downloadBlob(DocxGen.build(state, reportOpts()).teachersDocx(), '所有教師課表.docx', DOCX_MIME); toast(`已輸出 ${state.teachers.length} 位教師課表`); }
  catch (e) { console.error(e); toast('輸出失敗：' + e.message); }
}
function emptyState(title, sub) { return `<div class="card"><div class="empty"><div style="font-size:18px;font-weight:700;margin-bottom:6px">${esc(title)}</div><div>${esc(sub)}</div></div></div>`; }

/* ==========================================================================
   設定（上課日 / 節次定義 / 排課選項）
   ========================================================================== */
function viewSettings() {
  const dayToggles = [1, 2, 3, 4, 5, 6, 7].map(d =>
    `<label class="checkbox" style="display:inline-flex;margin-right:14px"><input type="checkbox" data-change="day-toggle" data-day="${d}" ${state.settings.days.includes(d) ? 'checked' : ''}> ${DAY_LABELS[d]}</label>`).join('');
  const periodRows = state.settings.periods.map((p, i) => `<tr>
    <td><input type="text" data-change="period-field" data-pid="${p.id}" data-field="label" value="${esc(p.label)}"></td>
    <td><input type="time" data-change="period-field" data-pid="${p.id}" data-field="start" value="${esc(p.start)}"></td>
    <td><input type="time" data-change="period-field" data-pid="${p.id}" data-field="end" value="${esc(p.end)}"></td>
    <td style="text-align:center"><input type="checkbox" data-change="period-break" data-pid="${p.id}" ${p.isBreak ? 'checked' : ''}></td>
    <td class="row-actions">
      <button class="icon-btn" data-action="move-period-up" data-pid="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-action="move-period-down" data-pid="${p.id}" ${i === state.settings.periods.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" data-action="del-period" data-pid="${p.id}">🗑️</button>
    </td></tr>`).join('');
  return `
    ${subHead('設定')}
    <div class="card"><div class="card-body"><h4 style="margin-top:0">上課日</h4><div>${dayToggles}</div></div></div>
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h4 style="margin:0">節次定義（全校共用）</h4><button class="ghost" data-action="add-period">＋ 新增節次</button>
      </div>
      <table class="data"><thead><tr><th>名稱</th><th>開始</th><th>結束</th><th style="text-align:center">午休/分隔</th><th></th></tr></thead><tbody>${periodRows}</tbody></table>
      <p class="hint" style="color:var(--muted);margin-top:8px">勾「午休/分隔」的節（如午休）不上課、不列入各年級節次表；其餘節才會在「年級」逐格勾上課日。</p>
    </div></div>
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h4 style="margin:0">專科教室</h4><button class="ghost" data-action="add-room">＋ 新增教室</button>
      </div>
      <div class="hint" style="color:var(--muted);margin-bottom:10px">🏫 <b>指派方式：</b>在這裡建立教室後，到「<b>③ 教師</b>」點教師編輯，在其<b>配課列（班級 → 科目 → 節數 → 教室）</b>最右邊的下拉選單，把教室指派給該科。排課時會自動檢查同一教室同時段是否被兩班搶用。</div>
      ${state.rooms.length === 0 ? `<div style="color:var(--muted)">尚無專科教室（例：電腦教室、自然教室、音樂教室、體育館）。</div>`
      : `<table class="data"><tbody>${state.rooms.map(r => `<tr>
          <td><b>${esc(r.name)}</b></td>
          <td>${state.teachers.reduce((n, t) => n + (t.load || []).filter(L => L.roomId === r.id).length, 0)} 筆配課使用</td>
          <td class="row-actions"><button class="icon-btn" data-action="edit-room" data-id="${r.id}">✏️</button><button class="icon-btn" data-action="del-room" data-id="${r.id}">🗑️</button></td>
        </tr>`).join('')}</tbody></table>`}
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">排課選項</h4>
      <label class="field" style="max-width:320px"><span>教師單日節數上限（自動排課用；0＝不限）</span>
        <input type="number" min="0" max="20" data-change="set-maxperday" value="${state.settings.maxLessonsPerDay || 0}"></label>
      <p class="hint" style="color:var(--muted);margin:6px 0 0">自動排課會避免任一教師單日超過此上限。個別教師可在「③ 教師」設不同上限；勾「不列入上限」的科目（如母語）不計。</p>
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">課表輸出格式（Word .docx）</h4>
      <p class="hint" style="color:var(--muted);margin:0 0 10px">「課表輸出」的📄一鍵輸出所有班級／教師課表會用到以下設定。</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <label class="field"><span>校名</span><input type="text" data-change="report-field" data-field="reportSchool" value="${esc(state.settings.reportSchool || '')}" placeholder="請輸入貴校校名" style="min-width:260px"></label>
        <label class="field"><span>學年度</span><input type="text" data-change="report-field" data-field="reportYear" value="${esc(state.settings.reportYear || '')}" placeholder="如 114" style="width:90px"></label>
        <label class="field"><span>學校代號</span><input type="text" data-change="report-field" data-field="schoolCode" value="${esc(state.settings.schoolCode || '')}" placeholder="msd9" style="width:110px" title="導師線上填課的檔名前綴（class-<代號><學年><年級><班代號>），多校共用時各校自填以區隔"></label>
      </div>
      <p class="hint" style="color:var(--muted);margin:0 0 12px;font-size:12px">「學校代號」用於「導師線上填課」的檔名前綴（<code>class-代號學年年級班代號</code>）；不同學校共用本系統時，各校填不同代號即可區隔、檔名不撞。</p>
      <h5 style="margin:0 0 6px">科目顯示名稱對照（輸出用；留空＝用原名）</h5>
      <table class="data"><tbody>${state.subjects.map(s => {
        const eff = (state.settings.subjectMap && state.settings.subjectMap[s.name] != null) ? state.settings.subjectMap[s.name]
          : (typeof DocxGen !== 'undefined' && DocxGen.DEFAULT_MAP[s.name] != null ? DocxGen.DEFAULT_MAP[s.name] : s.name);
        return `<tr><td style="width:140px">${esc(s.name)}</td><td><input type="text" data-change="subjmap-field" data-subj="${esc(s.name)}" value="${esc(eff)}" style="width:200px"></td></tr>`;
      }).join('')}</tbody></table>
      <p class="hint" style="color:var(--muted);margin-top:8px">母語可用「/」分列（如 阿美語/閩南語）。固定版面（整潔活動、導師時間、午餐、午休、第八節、週三下午教學研究、學生人數欄）已比照範本內建。</p>
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">🗓️ 學年度轉換</h4>
      <p style="color:var(--muted);margin:4px 0 10px">新學年時一鍵沿用本學年的所有設定（科目／年級／班級／教師配課／教室／協同／領域），只把排課清空重排，免重建。套用前會自動下載備份。</p>
      <button class="btn" data-action="new-school-year">另存為新學年（沿用設定）</button></div></div>
    ${cloudSettingsCard()}
    <div class="card"><div class="card-body"><h4 style="margin-top:0">🧹 疑難排解：只重設本 App</h4>
      <p style="color:var(--muted);margin:4px 0 10px">手機上若一直跳「請稍候」授權、卡住或畫面異常，用這個清除「課務編排」在本機的資料並重新載入。<b>只影響這個 App</b>，不會動到血壓記錄、智慧筆記本等其他 App。（有雲端備份的話重新連結即可取回；救急也可直接在網址列開 <code>?reset=1</code>）</p>
      <button class="ghost" data-action="reset-app" style="color:var(--danger)">🧹 清除本 App 資料並重設</button></div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">🧑‍🏫 導師線上填課</h4>
      <p style="color:var(--muted);margin:4px 0 10px">導師專用：用學校 Google 帳號登入，開啟排課老師分享給你的「班級填課檔」，為自編格選課後存回雲端。（排課老師的「開放/收回」在 ④ 排課鎖定後的「☁️ 線上填課」）</p>
      <button class="btn" data-action="teacher-fill">用 Google 登入並填課</button></div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">關於</h4>
      <p style="color:var(--muted)">課務編排 ${APP_VERSION} · 資料存本機瀏覽器。備份請用右上「備份」或下方雲端同步。</p>
    </div></div>`;
}
function roomModal(existing) {
  const r = existing || { name: '' };
  openModal({
    title: existing ? '編輯教室' : '新增教室',
    body: `<label class="field"><span>教室名稱</span><input type="text" id="rName" value="${esc(r.name)}" placeholder="例：電腦教室"></label>`,
    onSave: () => {
      const name = $('#rName').value.trim();
      if (!name) { toast('請輸入教室名稱'); return false; }
      if (existing) existing.name = name; else state.rooms.push({ id: uid(), name });
      save(); render(); toast('已儲存教室');
      return true;
    },
  });
}
function delRoom(id) {
  const r = roomById(id); if (!r) return;
  const uses = state.teachers.reduce((n, t) => n + (t.load || []).filter(L => L.roomId === id).length, 0);
  confirmDelete(`刪除教室「${r.name}」？${uses ? '（' + uses + ' 筆配課的教室將清空）' : ''}`, () => {
    state.teachers.forEach(t => (t.load || []).forEach(L => { if (L.roomId === id) L.roomId = ''; }));
    state.rooms = state.rooms.filter(x => x.id !== id);
  });
}

/* ==========================================================================
   Backup
   ========================================================================== */
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function backupMenu() {
  openModal({
    title: '備份 / 還原',
    body: `<p>資料只存在這台裝置的瀏覽器，建議定期匯出。</p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" data-action="export-json">⬇️ 匯出 JSON</button>
        <button class="ghost" data-action="import-json">⬆️ 匯入 JSON</button></div>
      <p class="hint" style="color:var(--danger);margin-top:12px">匯入會<b>覆蓋</b>目前所有資料。</p>`,
  });
}
function exportJSON() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  downloadBlob(JSON.stringify(state, null, 2), `課務編排_${stamp}.json`, 'application/json');
  toast('已匯出備份');
}
function importJSON() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || data.schema !== SCHEMA) throw new Error('版本不符（需 schema ' + SCHEMA + '）');
        state = data; if (!state.slotTeachers || typeof state.slotTeachers !== 'object') state.slotTeachers = {}; if (!state.slotContent || typeof state.slotContent !== 'object') state.slotContent = {}; if (!Array.isArray(state.lockedCells)) state.lockedCells = []; if (!Array.isArray(state.selfCells)) state.selfCells = []; if (!state.selfBackup || typeof state.selfBackup !== 'object') state.selfBackup = {}; if (!state.selfDone || typeof state.selfDone !== 'object') state.selfDone = {}; if (typeof state.staffingOkSig !== 'string') state.staffingOkSig = ''; if (!Array.isArray(state.substitutions)) state.substitutions = []; if (!Array.isArray(state.substDeleted)) state.substDeleted = []; normalizeAllSubst(); save(); closeModal(); selectedGradeId = null; render(); toast('已匯入備份');
      } catch (e) { toast('匯入失敗：' + e.message); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

/* ==========================================================================
   Shared UI
   ========================================================================== */
function emptyCard(title, sub) {
  return `<div class="card"><div class="empty"><b>${esc(title)}</b><div style="margin-top:4px">${esc(sub)}</div></div></div>`;
}
function confirmDelete(msg, fn) {
  openModal({ title: '確認刪除', body: `<p>${esc(msg)}</p>`, saveLabel: '刪除', onSave: () => { fn(); save(); render(); toast('已刪除'); return true; } });
  const btn = $('#modalRoot [data-action="modal-save"]'); if (btn) btn.classList.add('danger');
}
function movePeriod(pid, dir) {
  const arr = state.settings.periods; const i = arr.findIndex(p => p.id === pid); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]]; save(); render();
}

/* ==========================================================================
   使用說明
   ========================================================================== */
function helpModal() {
  const sec = (title, inner) => `<details class="help-sec"><summary>${title}</summary><div class="sec-body">${inner}</div></details>`;
  openModal({
    title: '使用說明　·　' + APP_VERSION, wide: true, body: `<div class="help">
    <div class="help-note">📌 <b>三個重點：</b>①免安裝，開網址就能用；基本操作免登入（只有<b>雲端同步、導師線上填課、線上代課填報</b>才需 Google 登入）。②資料只存<b>你這台裝置</b>的瀏覽器。③換裝置／清瀏覽器前，先用首頁「💾 備份」匯出或開啟雲端同步。</div>
    <p class="help-flow">①科目 ▸ ②年級與班級 ▸ ③教師配課 ▸ ④排課 ▸ 課表輸出</p>
    <p style="color:var(--muted);font-size:13px;margin:2px 0 10px">點各段標題展開／收合。</p>

    ${sec('🏠 首頁與導覽', `<ul>
      <li>開啟 App 落在<b>首頁</b>：顯示各步驟<b>完成度</b>、<b>待辦</b>（缺配課／缺導師／未排滿／未鎖定／久未備份）與<b>快速入口</b>；點卡片或待辦可直接跳到對應位置。</li>
      <li>首次使用會跳「<b>初次設定</b>」，填<b>校名／學年度／學校代號</b>，立即顯示在首頁抬頭；日後可在「⚙️ 設定」修改。</li>
      <li>每個子頁頂端有<b>導覽列</b>：核心四頁（科目／年級與班級／教師配課／排課）可互相切換，其餘頁有「← 回首頁」。</li>
      <li><b>💾 備份</b>在首頁抬頭；<b>❓ 使用說明</b>在首頁快速入口。</li></ul>`)}

    ${sec('① 科目', `<ul>
      <li>建立科目、選顏色，可指定<b>所屬領域</b>（供「領域節數」對照，可留未分類）。</li>
      <li><b>教學型態</b>三選一：<b>單一教師</b>；<b>👥 分組教學</b>（同班多師「同一節」平行、不算衝堂，如英語）；<b>✂️ 分節上課</b>（多師分攤節數、各上「不同節」，如生活 6 節＝A 4＋B 2）。</li>
      <li>⏱ <b>需連堂</b>：兩節相鄰。奇數節可填「連堂次數」，剩 1 節單獨排<b>不算錯</b>。</li>
      <li>🔒 <b>排課限制</b>＋🪄 <b>自動排課偏好</b>（皆只影響自動排課、手動不受限）：限定上課日／節次、偏好節次、多節分散、主科不排末節、不列入教師單日上限等。</li></ul>`)}

    ${sec('② 年級與班級', `<ul>
      <li><b>年級設定</b>：<b>節次表</b>（逐格勾哪節×哪天有課）＋<b>科目節數</b>（勾科目填節數；總和＝可用節數時該年級才算完成 ✓）。</li>
      <li><b>班級</b>：新增並選年級，課程<b>自動沿用該年級</b>；可填<b>數字代號</b>（線上填課檔名用）；點「科目／協同」可設<b>協同教學</b>的同年級其他班（同時段一起上）。</li></ul>`)}

    ${sec('③ 教師配課', `<ul>
      <li>填姓名、身分、<b>每周授課時數</b>、不排課時段、<b>Google Email</b>（線上分享用，學校或個人 Gmail 皆可）；<b>級任</b>另設<b>導師班級</b>。</li>
      <li><b>配課</b>：逐筆「班級 → 科目 → 節數 → 教室（可留空）」，合計<b>須等於授課時數</b>才能存。✂️ 分節科目可把節數拆給不同老師。</li>
      <li>⚠ <b>檢查全校配課</b>（進 ④ 排課的關卡）：<b>每班每科配齊＋每班都有導師</b>才通過，通過才解鎖排課；資料一改需<b>再按一次</b>。</li>
      <li>🧮 <b>配課矩陣</b>：一張表看每班每科誰配、已配／應排（<b>綠足、紅缺、橘超額</b>）。</li></ul>`)}

    ${sec('④ 排課', `<ul>
      <li>選班 → 點科目 → 點空格放課；點已排格移除；灰格＝不上課。</li>
      <li>💡 <b>空格建議</b>（未選科目點空格看可放什麼）、🔧 <b>喬課</b>（調課連鎖、保證不衝堂）、🧭 <b>教師可調總覽</b>（看某師每節可移到幾處）。</li>
      <li>🪄 <b>自動排課</b>：一鍵排滿，遵守所有限制並避開衝堂；可「清空重排」或「只補空格」；排不下的會列出。</li>
      <li>✂️ 分節先選老師再點格；分組自動多師同格；協同放一班自動同步；連堂自動成對。</li>
      <li>↶ <b>復原／重做</b>（Ctrl+Z／Ctrl+Y）；🔴 紅框＝需注意（衝堂／不排課／協同未同步／連堂未相鄰）。</li></ul>`)}

    ${sec('🔒 鎖定與導師自編（排課定稿後）', `<ul>
      <li><b>🔒 一鍵鎖定</b>整表，或 <b>🎯 單格鎖定</b>逐格選；鎖定時系統自動把<b>本班導師任課格</b>釋放為空白供導師選課，其餘唯讀。</li>
      <li><b>導師選課</b>：點自編格從導師配課科目挑（協同連動夥伴班）；<b>✅ 導師自編完成</b>鎖本班（有空格或衝堂會拒絕）；<b>🔓 解鎖導師自編</b>可重選。</li>
      <li><b>🔓 解除鎖定</b>（整表）：自編格<b>還原成鎖定前的原排課</b>。</li></ul>`)}

    ${sec('🧑‍🏫 導師線上填課', `<ul>
      <li><b>用途</b>：鎖定後把各班「自編格選課」開放給該班導師線上填，再收回合併（走 Google Drive、需登入）。</li>
      <li><b>排課者</b>：先填好各班<b>導師 Email</b>＋<b>班級代號</b> → 鎖定 → ④排課橫幅「<b>☁️ 線上填課</b>」開放（系統建各班填課檔、逐位分享、給你一條<b>填課連結</b>）。</li>
      <li><b>導師</b>：開連結登入 → 選自己班的檔 → 點 🧩 自編格選課 → 存雲端。系統<b>核對帳號、只能開自己班</b>。</li>
      <li>📊 <b>進度總覽</b>：可看各班狀態、複製未交名單催交；排課者按「<b>收回填課</b>」合併並顯示每班摘要。</li></ul>`)}

    ${sec('🔄 代課（分頁「代課」）', `<ul>
      <li><b>用途</b>：某老師請假時安排代課、印出相關課表；<b>不會更動原排課</b>。</li>
      <li><b>流程</b>：＋新增代課 → 選<b>請假老師</b>＋<b>起訖日期</b>（可跨多天／半天／指定節次）→ 調出其課表，點<b>有課的格子</b>指派當節<b>空堂</b>的老師 → 列印／存 PDF。可多筆、可刪除。</li>
      <li><b>長假分週指派</b>：以「全部週」為底，某週要換人就切到<b>該週</b>單獨指派（其餘週仍沿用）。</li>
      <li><b>防呆</b>：同一時段已被指派、或請假日期重疊會擋。</li>
      <li>🧑‍🏫 <b>代課老師合併總表</b>：一次看每位代課老師的所有代課。</li>
      <li>☁️ <b>線上代課填報</b>：把填報開放給老師線上自己填——排課者按「☁️ 線上代課填報」開放（逐位 Email 分享、給連結）；老師開連結登入，系統用 Email 對應本人，<b>只能新增自己的代課</b>並送出雲端；排課者「<b>收回</b>」合併。</li></ul>`)}

    ${sec('領域節數', `<ul>
      <li><b>建議節數參考表</b>：可改名稱／節數、新增或刪除領域；內建 108 課綱起始值，<b>請務必校對</b>。</li>
      <li><b>實配／建議對照</b>：把年級科目節數依所屬領域加總與建議並排，<b>相符綠、不符紅</b>；未指定領域者列「未分類」。</li></ul>`)}

    ${sec('課表輸出 / 備份', `<ul>
      <li>類型：<b>班級表、教師表、全校總表（各班）、全校教師總表</b>。</li>
      <li>可<b>列印／存 PDF／匯出 CSV／一鍵 Word（.docx）</b>；兩種全校總表可<b>橫向列印</b>或<b>下載 PNG</b> 直接貼公告。</li>
      <li>首頁「💾 備份」可匯出／匯入 JSON（換裝置用）。</li></ul>`)}

    ${sec('☁️ 雲端同步（設定頁）', `<ul>
      <li>連結 Google 後自動備份到<b>你自己的雲端硬碟</b>（App 專屬隱藏資料夾、無伺服器）。</li>
      <li><b>多裝置接續</b>：另一台開啟時若雲端較新會問是否還原；可挑<b>歷史版本（最多 7 份）</b>；可更換帳號／解除連結。</li></ul>`)}
    </div>`,
  });
}

/* ==========================================================================
   雲端同步：Google Drive（appDataFolder）— v07.00
   模型：整份 state 備份到「使用者自己 Google 雲端」的隱藏 App 專屬資料夾，
   無伺服器。單一 JSON 檔、last-write-wins；開 App 若雲端較新則詢問還原；
   偵測到跨裝置衝突時把雲端舊版另存 .prev；每天首次變更保留一份歷史版本（最多 7）。
   ========================================================================== */
function loadCloudState() {
  const defaults = { enabled: false, email: '', dataOwnerEmail: '', fileId: '', prevFileId: '', lastSyncedAt: '', lastSnapshotDate: '', pendingBackup: false, backupFailed: false, deviceId: '' };
  let s;
  try { s = { ...defaults, ...JSON.parse(localStorage.getItem(CLOUD_KEY)) }; }
  catch { s = { ...defaults }; }
  if (!s.deviceId) s.deviceId = (crypto.randomUUID ? crypto.randomUUID() : uid() + uid());
  localStorage.setItem(CLOUD_KEY, JSON.stringify(s));
  return s;
}
function saveCloudState() { localStorage.setItem(CLOUD_KEY, JSON.stringify(cloudState)); }
const cloudConfigured = () => !!GOOGLE_CLIENT_ID;

function friendlyCloudErr(e) {
  const m = (e && e.message) || '';
  if (/popup_closed|access_denied|interaction_required|auth_failed|popup_failed/i.test(m)) return '登入未完成';
  if (/network|Failed to fetch/i.test(m)) return '網路連線問題';
  return '請稍後再試';
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hasLocalData = () => state.subjects.length > 0 || state.classes.length > 0 || state.teachers.length > 0;

/* ---- GIS / token ---- */
function ensureGis() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    let s = document.getElementById('gisScript');
    if (s) { s.addEventListener('load', () => resolve()); s.addEventListener('error', () => reject(new Error('network'))); return; }
    s = document.createElement('script');
    s.id = 'gisScript'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('network'));
    document.head.appendChild(s);
  });
}
function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPE,
    callback: (resp) => {
      const ok = _tokResolve, fail = _tokReject; _tokResolve = _tokReject = null;
      if (resp && resp.access_token) { gisToken = { access_token: resp.access_token, expiresAt: Date.now() + ((Number(resp.expires_in) || 3600) * 1000) }; ok && ok(resp.access_token); }
      else fail && fail(new Error((resp && resp.error) || 'auth_failed'));
    },
    error_callback: (err) => { const fail = _tokReject; _tokResolve = _tokReject = null; fail && fail(new Error((err && err.type) || 'popup_closed')); },
  });
}
// promptMode: 'none' 純背景（無 UI，會話失效即失敗）；'' 使用者手勢（已授權則靜默、否則彈窗）。
async function getAccessToken(promptMode = '') {
  await ensureGis();
  if (gisToken && gisToken.expiresAt - 60000 > Date.now()) return gisToken.access_token;
  if (!tokenClient) initTokenClient();
  return new Promise((resolve, reject) => {
    // v10.05 逾時保護：Android 獨立 PWA 下 GIS 有時 callback/error_callback 都不觸發，
    // 若不設逾時會永遠卡住（轉圈/白畫面）。25 秒沒回應就 reject，讓上層能收尾。
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); _tokResolve = _tokReject = null; fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 25000);
    _tokResolve = (v) => finish(resolve, v);
    _tokReject = (v) => finish(reject, v);
    try { tokenClient.requestAccessToken({ prompt: promptMode }); }
    catch (e) { finish(reject, e); }
  });
}
async function driveFetch(url, opts) {
  let token = await getAccessToken('none');
  const build = (t) => ({ ...opts, headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + t } });
  let res = await fetch(url, build(token));
  if (res.status === 401) { gisToken = null; token = await getAccessToken('none'); res = await fetch(url, build(token)); }
  return res;
}

/* ---- Drive REST ---- */
async function driveFindFile(name) {
  const q = encodeURIComponent(`name='${name}'`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,appProperties)&pageSize=5`, { method: 'GET' });
  if (!res.ok) throw new Error('list_failed');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}
async function driveGetMeta(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,appProperties,modifiedTime`, { method: 'GET' });
  if (!res.ok) return null;
  return res.json();
}
async function driveDownloadText(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { method: 'GET' });
  if (!res.ok) throw new Error('download_failed');
  return res.text();
}
async function driveGetUserEmail() {
  try {
    const res = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user', { method: 'GET' });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.user && data.user.emailAddress) || '';
  } catch { return ''; }
}
async function refreshCloudEmailIfMissing() {
  if (!cloudState.enabled) return;
  let changed = false;
  if (!cloudState.email) { const email = await driveGetUserEmail(); if (email) { cloudState.email = email; changed = true; } }
  if (cloudState.email && !cloudState.dataOwnerEmail) { cloudState.dataOwnerEmail = cloudState.email; changed = true; }
  if (changed) { saveCloudState(); updateCloudUI(); }
}
async function driveUpload(fileId, name, contentStr, appProps) {
  const boundary = 'csb' + Math.random().toString(16).slice(2);
  const metadata = fileId ? { appProperties: appProps } : { name, parents: ['appDataFolder'], appProperties: appProps };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + contentStr + `\r\n--${boundary}--`;
  const base = 'https://www.googleapis.com/upload/drive/v3/files';
  const url = fileId ? `${base}/${fileId}?uploadType=multipart&fields=id,appProperties` : `${base}?uploadType=multipart&fields=id,appProperties`;
  const res = await driveFetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!res.ok) throw new Error('upload_failed');
  return res.json();
}
async function driveCopyFile(fileId, name, appProps) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy?fields=id,appProperties,createdTime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties: appProps }),
  });
  if (!res.ok) throw new Error('copy_failed');
  return res.json();
}
async function driveDelete(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
  return res.ok || res.status === 404;
}
async function resolveMainFileId() {
  // 一律以「檔名」重新確認主檔 id：cloudState.fileId 可能因另一台裝置重建檔案、
  // 清除歷史或帳號動作而失效；若盲信舊 id，備份會 PATCH 到不存在的 id 而失敗、
  // 還原會下載 404 而誤判「沒有備份」（本機備份時間會停在某天不再前進）。
  try {
    const f = await driveFindFile(CLOUD_FILE_NAME);
    if (f) { if (cloudState.fileId !== f.id) { cloudState.fileId = f.id; saveCloudState(); } return f.id; }
    // 名稱查詢成功但查無此檔 → 確實沒有；清掉可能失效的快取 id
    if (cloudState.fileId) { cloudState.fileId = ''; saveCloudState(); }
    return '';
  } catch (e) {
    // 列檔失敗（網路/暫時性）→ 退回快取 id，不要清空
    return cloudState.fileId || '';
  }
}
async function preserveRemoteAsPrev(fileId) {
  try {
    const text = await driveDownloadText(fileId);
    const r = await driveUpload(cloudState.prevFileId || '', CLOUD_PREV_NAME, text, { savedAt: new Date().toISOString() });
    cloudState.prevFileId = r.id; saveCloudState();
  } catch {}
}

/* ---- 歷史版本快照（course-history-<epoch>.json，最多 7）---- */
function snapshotTime(f) {
  const s = f.appProperties && f.appProperties.snapshotAt;
  const t = s ? Date.parse(s) : Date.parse(f.createdTime || '');
  return Number.isNaN(t) ? 0 : t;
}
async function listSnapshots() {
  const q = encodeURIComponent(`name contains '${CLOUD_HISTORY_PREFIX}'`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,createdTime,appProperties)&pageSize=50`, { method: 'GET' });
  if (!res.ok) throw new Error('list_failed');
  const data = await res.json();
  return (data.files || []).sort((a, b) => snapshotTime(b) - snapshotTime(a));
}
async function pruneSnapshots(max) {
  const snaps = await listSnapshots();
  for (const f of snaps.slice(max)) { try { await driveDelete(f.id); } catch {} }
}
async function createDailySnapshot() {
  const mainId = await resolveMainFileId();
  if (!mainId) return;
  const meta = await driveGetMeta(mainId);
  const props = { snapshotAt: new Date().toISOString(), dateStr: localDateStr(), classes: (meta && meta.appProperties && meta.appProperties.classes) || '' };
  await driveCopyFile(mainId, `${CLOUD_HISTORY_PREFIX}${Date.now()}.json`, props);
  await pruneSnapshots(7);
}
function maybeDailySnapshot() {
  if (!cloudState.enabled || suppressCloud || snapshotInFlight) return;
  const today = localDateStr();
  if (cloudState.lastSnapshotDate === today) return;
  snapshotInFlight = true;
  createDailySnapshot().then(() => { cloudState.lastSnapshotDate = today; saveCloudState(); }).catch(() => {}).finally(() => { snapshotInFlight = false; });
}

/* ---- 備份物件（整份 state）---- */
function buildBackupObject() {
  return { courseSchedulerBackup: true, schema: SCHEMA, exportedAt: new Date().toISOString(), state };
}
async function applyBackupObject(data) {
  const st = (data && data.state) ? data.state : data;   // 容錯：允許直接是 state
  if (!st || st.schema !== SCHEMA) throw new Error('bad_backup');
  suppressCloud = true;
  try {
    state = st;
    if (!Array.isArray(state.rooms)) state.rooms = [];
    if (!state.slotTeachers || typeof state.slotTeachers !== 'object') state.slotTeachers = {};
    if (!state.slotContent || typeof state.slotContent !== 'object') state.slotContent = {};
    if (!Array.isArray(state.lockedCells)) state.lockedCells = [];
    if (!Array.isArray(state.selfCells)) state.selfCells = [];
    if (!state.selfBackup || typeof state.selfBackup !== 'object') state.selfBackup = {};
    if (!state.selfDone || typeof state.selfDone !== 'object') state.selfDone = {};
    if (typeof state.staffingOkSig !== 'string') state.staffingOkSig = '';
    if (!Array.isArray(state.domains)) state.domains = defaultDomains();
    if (!Array.isArray(state.substitutions)) state.substitutions = [];
    if (!Array.isArray(state.substDeleted)) state.substDeleted = [];
    normalizeAllSubst();
    if (!state.settings.subjectMap || typeof state.settings.subjectMap !== 'object') state.settings.subjectMap = {};
    await idbSet(STATE_KEY, state);   // 直接寫 IDB，繞過 save() 的雲端 hook
    selectedGradeId = null;
    render();
  } finally { suppressCloud = false; }
}

/* ---- UI 狀態 ---- */
function setCloudBusy(b) { cloudBusy = b; updateCloudUI(); }
function updateCloudUI() { if (currentTab === 'settings') render(); }   // 設定頁的雲端卡片由 render 依 cloudState 重畫

function scheduleCloudBackup() {
  if (!cloudState.enabled || suppressCloud) return;
  if (!cloudState.pendingBackup) { cloudState.pendingBackup = true; saveCloudState(); updateCloudUI(); }
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { cloudBackupNow({}); }, CLOUD_DEBOUNCE_MS);
}

async function cloudBackupNow({ manual = false, interactive = false } = {}) {
  if (!cloudState.enabled && !interactive) return;
  if (cloudBusy) return;
  setCloudBusy(true);
  try {
    if (interactive) await getAccessToken('');
    const updatedAt = new Date().toISOString();
    const bundle = buildBackupObject();
    bundle.cloudUpdatedAt = updatedAt; bundle.deviceId = cloudState.deviceId;
    const contentStr = JSON.stringify(bundle);
    const fileId = await resolveMainFileId();
    if (fileId) {
      const meta = await driveGetMeta(fileId);
      const remoteUpdated = meta && meta.appProperties && meta.appProperties.updatedAt;
      if (remoteUpdated && remoteUpdated !== cloudState.lastSyncedAt) await preserveRemoteAsPrev(fileId);
    }
    const result = await driveUpload(fileId, CLOUD_FILE_NAME, contentStr, { updatedAt, deviceId: cloudState.deviceId, classes: String(state.classes.length) });
    cloudState.fileId = result.id; cloudState.lastSyncedAt = updatedAt;
    cloudState.pendingBackup = false; cloudState.backupFailed = false;
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email;
    saveCloudState(); updateCloudUI();
    if (manual) toast('已備份到雲端');
  } catch (e) {
    cloudState.backupFailed = true; saveCloudState(); updateCloudUI();
    if (manual || interactive) toast('雲端備份失敗：' + friendlyCloudErr(e));
  } finally { setCloudBusy(false); }
}

async function cloudRestore({ manual = false, confirmFirst = true, confirmMsg = '' } = {}) {
  setCloudBusy(true);
  try {
    if (manual) await getAccessToken('');
    const fileId = await resolveMainFileId();
    if (!fileId) { if (manual) toast('雲端沒有備份可還原'); return 'none'; }
    const text = await driveDownloadText(fileId);
    let data; try { data = JSON.parse(text); } catch { toast('雲端備份格式錯誤'); return 'error'; }
    const st = (data && data.state) ? data.state : data;
    if (!st || st.schema !== SCHEMA) { toast('雲端備份格式錯誤或版本不符'); return 'error'; }
    if (confirmFirst) {
      const msg = confirmMsg || `確定要用雲端備份還原嗎？這會覆蓋此裝置目前所有資料（雲端共 ${(st.classes || []).length} 班）。`;
      if (!confirm(msg)) return 'declined';
    }
    await applyBackupObject(data);
    const meta = await driveGetMeta(fileId);
    cloudState.lastSyncedAt = (meta && meta.appProperties && meta.appProperties.updatedAt) || data.cloudUpdatedAt || cloudState.lastSyncedAt;
    cloudState.pendingBackup = false; cloudState.backupFailed = false;
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email;
    saveCloudState(); updateCloudUI();
    toast('已從雲端還原');
    return 'restored';
  } catch (e) { toast('雲端還原失敗：' + friendlyCloudErr(e)); return 'error'; }
  finally { setCloudBusy(false); }
}

/* ---- 診斷：只讀列出授權帳號與 App 資料夾內所有檔案，找出「沒有備份可還原」的真因 ---- */
async function cloudDiagnose() {
  setCloudBusy(true);
  const lines = [];
  const add = (k, v) => lines.push(`<tr><td style="color:var(--muted);white-space:nowrap;padding:2px 10px 2px 0;vertical-align:top">${esc(k)}</td><td style="word-break:break-all">${esc(v)}</td></tr>`);
  try {
    add('App 主檔名', CLOUD_FILE_NAME);
    add('OAuth 用戶端', GOOGLE_CLIENT_ID.slice(0, 24) + '…');
    add('本機記錄帳號', cloudState.email || '(無)');
    add('資料擁有者', cloudState.dataOwnerEmail || '(無)');
    add('本機記錄 fileId', cloudState.fileId || '(無)');
    add('上次成功備份', cloudState.lastSyncedAt ? fmtDateTime(cloudState.lastSyncedAt) : '(從未)');
    let rawErr = '';
    try {
      await getAccessToken('');
      const email = await driveGetUserEmail();
      add('本次授權帳號', email || '(讀取失敗)');
      if (email && cloudState.email && email !== cloudState.email)
        add('⚠ 帳號不一致', `本次授權「${email}」與本機記錄「${cloudState.email}」不同 → 備份在另一個帳號`);
      // 不加任何 name 過濾，列出 App 資料夾全部檔案
      const res = await driveFetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&pageSize=100&orderBy=modifiedTime desc', { method: 'GET' });
      if (!res.ok) { rawErr = `列檔 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`; }
      else {
        const data = await res.json();
        const files = data.files || [];
        add('App 資料夾檔案數', String(files.length));
        if (files.length === 0) add('→ 判讀', '此帳號的 App 資料夾是空的：備份從未成功寫入，或此帳號非當初備份的帳號。');
        files.slice(0, 30).forEach((f, i) => add(`檔案 ${i + 1}`, `${f.name}　${fmtDateTime(f.modifiedTime)}　${f.size ? Math.round(f.size / 1024) + 'KB' : ''}`));
      }
    } catch (e) { rawErr = (e && e.message) || String(e); }
    if (rawErr) add('原始錯誤', rawErr);
  } finally { setCloudBusy(false); }
  openModal({
    title: '🔍 雲端同步診斷',
    body: `<p style="margin-top:0;color:var(--muted)">以下為只讀檢查，不會更動任何資料。把整份結果回報即可對症修正。</p>
      <table style="font-size:13px;border-collapse:collapse;width:100%"><tbody>${lines.join('')}</tbody></table>`,
  });
}

/* ---- 還原版本選擇器（最新 + 歷史版本）---- */
async function openRestorePicker() {
  setCloudBusy(true);
  let items = [];
  try {
    await getAccessToken('');
    const mainId = await resolveMainFileId();
    if (mainId) {
      const meta = await driveGetMeta(mainId);
      const p = (meta && meta.appProperties) || {};
      items.push({ value: 'latest', main: '最新版本（即時）', sub: [fmtDateTime(p.updatedAt), p.classes ? `${p.classes} 班` : ''].filter(Boolean).join('　') });
    }
    let snaps = []; try { snaps = await listSnapshots(); } catch {}
    for (const f of snaps) {
      const p = f.appProperties || {};
      items.push({ value: f.id, main: `歷史版本　${p.dateStr || ''}`.trim(), sub: [fmtDateTime(p.snapshotAt || f.createdTime), p.classes ? `${p.classes} 班` : ''].filter(Boolean).join('　') });
    }
  } catch (e) { toast('讀取版本清單失敗：' + friendlyCloudErr(e)); setCloudBusy(false); return; }
  setCloudBusy(false);
  if (items.length === 0) { toast('雲端沒有備份可還原'); return; }
  const rows = items.map((it, i) => `<label class="restore-item">
    <input type="radio" name="rv" value="${esc(it.value)}" ${i === 0 ? 'checked' : ''}>
    <span><b>${esc(it.main)}</b><br><small style="color:var(--muted)">${esc(it.sub)}</small></span></label>`).join('');
  openModal({
    title: '選擇還原版本', saveLabel: '還原此版本',
    body: `<p style="margin-top:0;color:var(--muted)">還原會覆蓋此裝置目前資料，並成為雲端最新版本。</p><div class="restore-list">${rows}</div>`,
    onSave: () => {
      const sel = document.querySelector('input[name="rv"]:checked'); if (!sel) return false;
      const value = sel.value; const label = sel.closest('.restore-item').querySelector('b').textContent;
      closeModal();
      if (value === 'latest') cloudRestore({ manual: true }); else restoreFromSnapshot(value, label);
      return true;
    },
  });
}
async function restoreFromSnapshot(fileId, label) {
  setCloudBusy(true);
  try {
    const text = await driveDownloadText(fileId);
    let data; try { data = JSON.parse(text); } catch { toast('版本資料格式錯誤'); return; }
    const st = (data && data.state) ? data.state : data;
    if (!st || st.schema !== SCHEMA) { toast('版本資料格式錯誤或版本不符'); return; }
    if (!confirm(`確定要還原到「${label}」嗎？這會覆蓋此裝置目前所有資料（該版本 ${(st.classes || []).length} 班），並成為雲端最新版本。`)) return;
    await applyBackupObject(data);
    cloudState.lastSyncedAt = '';   // 讓下次上傳把目前雲端最新另存為 .prev 再覆蓋
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email;
    saveCloudState();
    await cloudBackupNow({});
    updateCloudUI(); toast('已還原並更新雲端最新版本');
  } catch (e) { toast('還原失敗：' + friendlyCloudErr(e)); }
  finally { setCloudBusy(false); }
}

/* ---- 首次連結：跟雲端對帳，避免任一邊資料被吃掉 ---- */
async function cloudReconcileOnConnect() {
  const f = await driveFindFile(CLOUD_FILE_NAME);
  if (!f) { await cloudBackupNow({ manual: true }); return; }
  cloudState.fileId = f.id; saveCloudState();
  if (!hasLocalData()) { await cloudRestore({ manual: true, confirmFirst: false }); return; }
  const restore = confirm('雲端已有一份備份。\n\n選「確定」＝用雲端資料還原到此裝置；\n選「取消」＝保留此裝置資料並上傳覆蓋雲端。');
  if (restore) await cloudRestore({ manual: true, confirmFirst: false }); else await cloudBackupNow({ manual: true });
}

async function clearAllLocalData() {
  suppressCloud = true;
  try { state = defaultState(); await idbSet(STATE_KEY, state); selectedGradeId = null; currentTab = 'home'; render(); }
  finally { suppressCloud = false; }
}

// v10.05 只重設「本 App」：清 course_scheduler 的 IDB + course_cloud_v1 + 本 App 自己的 SW/快取，
// 明確不動血壓記錄／智慧筆記本等其他 App（它們同 origin 但 DB 名/localStorage key/SW scope/快取名皆不同）。
// 用途：手機上若卡在授權迴圈或畫面異常，改用這個取代瀏覽器「清除全站資料」（後者會連其他 App 一起清）。
async function resetThisAppData() {
  const onResetUrl = new URLSearchParams(location.search).has('reset');
  const msg = '這會清除「課務編排」在這台裝置的本機資料與雲端連結設定，然後重新載入。\n\n' +
    '✅ 只影響這個 App，不會動到「血壓記錄」「智慧筆記本」等其他 App 的資料。\n' +
    '☁️ 若你有連結 Google 雲端備份，雲端上的備份不會被刪除，重新連結即可取回。\n\n確定要重設嗎？';
  if (!confirm(msg)) { if (onResetUrl) location.replace(location.pathname); return; }
  try { localStorage.removeItem(CLOUD_KEY); } catch {}
  try { await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => res(); }); } catch {}
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        const url = (reg.active && reg.active.scriptURL) || '';
        if (reg.scope.indexOf('/course-scheduler/') >= 0 || url.indexOf('/course-scheduler/') >= 0) await reg.unregister();
      }
    }
  } catch {}
  try { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.indexOf('course-scheduler') === 0).map(k => caches.delete(k))); } catch {}
  location.replace(location.pathname);   // 去掉 ?reset 等 query，乾淨重載
}

async function cloudConnect({ switchAccount = false } = {}) {
  if (!cloudConfigured()) { toast('雲端同步尚未設定（需先設定 OAuth 用戶端）'); return; }
  setCloudBusy(true);
  try {
    if (switchAccount) gisToken = null;
    await getAccessToken(switchAccount ? 'select_account' : '');
    const newEmail = await driveGetUserEmail();
    const prevOwner = cloudState.dataOwnerEmail || cloudState.email;
    const switching = hasLocalData() && !!prevOwner && !!newEmail && prevOwner !== newEmail;
    if (switching && !switchAccount) {
      const ok = confirm(`偵測到更換帳號。\n\n此裝置目前的資料屬於「${prevOwner}」，將先清除，改用「${newEmail}」的雲端資料。\n（前一個帳號的雲端備份仍會保留，之後可再切回。）\n\n確定要更換嗎？`);
      if (!ok) { toast('已取消更換帳號'); return; }
    }
    if (switching) await clearAllLocalData();
    cloudState.enabled = true; cloudState.email = newEmail;
    cloudState.fileId = ''; cloudState.prevFileId = ''; cloudState.lastSyncedAt = ''; cloudState.lastSnapshotDate = '';
    saveCloudState(); updateCloudUI();
    toast(switching ? '已更換帳號' : '已連結 Google 雲端備份');
    await cloudReconcileOnConnect();
    if (newEmail) { cloudState.dataOwnerEmail = newEmail; saveCloudState(); updateCloudUI(); }
  } catch (e) { toast('連結失敗：' + friendlyCloudErr(e)); }
  finally { setCloudBusy(false); }
}
async function cloudSwitchAccount() {
  if (!confirm('更換帳號會先清除此裝置上目前帳號的資料，再改用你選擇的另一個 Google 帳號的雲端資料。\n（目前帳號的雲端備份仍會保留，之後可再切回。）\n\n要選擇要更換的帳號嗎？')) return;
  await cloudConnect({ switchAccount: true });
}
function cloudDisconnect() {
  if (!confirm('解除連結後，此裝置將停止自動備份（雲端上已存的備份不會被刪除）。確定解除？')) return;
  try { if (gisToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(gisToken.access_token, () => {}); } catch {}
  gisToken = null;
  Object.assign(cloudState, { enabled: false, email: '', fileId: '', prevFileId: '', lastSyncedAt: '', pendingBackup: false, backupFailed: false });
  saveCloudState(); updateCloudUI(); toast('已解除雲端連結');
}
async function cloudCheckOnOpen() {
  // v10.05 迴圈防護：本函式原本不設 cloudBusy，導致 visibilitychange 每次回前景都能重入，
  // 在 Android 獨立 PWA（token 會跳轉 accounts.google.com「請稍候」再跳回）下形成無限授權迴圈。
  if (!cloudState.enabled || cloudBusy || cloudCheckInFlight || cloudAutoDisabledThisSession) return;
  cloudCheckInFlight = true; cloudLastCheckAt = Date.now();
  try {
    const fileId = await resolveMainFileId();
    if (!fileId) return;
    const meta = await driveGetMeta(fileId);
    const remoteUpdated = meta && meta.appProperties && meta.appProperties.updatedAt;
    if (!remoteUpdated || remoteUpdated === cloudState.lastSyncedAt) return;
    const status = await cloudRestore({ confirmFirst: true, confirmMsg: '雲端有較新的備份（可能來自其他裝置）。\n\n要用雲端資料還原到此裝置嗎？選「取消」則保留此裝置資料，之後的變更會覆蓋雲端。' });
    if (status === 'declined') await cloudBackupNow({});
  } catch {
    // 自動查失敗（含 token 逾時／授權卡住）→ 本 session 不再自動重試，避免迴圈。
    // 手動備份／還原不受影響（各自獨立），使用者仍可在設定頁主動同步。
    cloudAutoDisabledThisSession = true;
  } finally { cloudCheckInFlight = false; }
}

function cloudSettingsCard() {
  const busy = cloudBusy ? 'disabled' : '';
  if (!cloudConfigured()) {
    return `<div class="card"><div class="card-body"><h4 style="margin-top:0">☁️ 雲端同步（Google 雲端硬碟）</h4>
      <p style="color:var(--warn);margin:0">尚未設定：需先在 Google Cloud Console 建立本 App 專屬的 OAuth 用戶端，並把用戶端 ID 填入程式 <code>GOOGLE_CLIENT_ID</code>。設定後即可一鍵備份／多裝置接續。</p></div></div>`;
  }
  if (!cloudState.enabled) {
    return `<div class="card"><div class="card-body"><h4 style="margin-top:0">☁️ 雲端同步（Google 雲端硬碟）</h4>
      <p style="color:var(--muted);margin:0 0 10px">連結你的 Google 帳號，把排課資料自動備份到「你自己雲端硬碟」的 App 專屬隱藏資料夾（無伺服器）。可在筆電／桌機間接續，並保留每日歷史版本。</p>
      <button class="btn" data-action="cloud-connect" ${busy}>🔗 連結 Google 雲端備份</button></div></div>`;
  }
  const last = cloudState.lastSyncedAt ? fmtDateTime(cloudState.lastSyncedAt) : '';
  let status, cls = '';
  if (cloudState.backupFailed) { status = `⚠ 有變更尚未備份成功${last ? `（上次成功：${last}）` : ''}，請按「立即備份」。`; cls = 'style="color:var(--danger)"'; }
  else if (cloudState.pendingBackup) status = `備份中…${last ? `（上次：${last}）` : ''}`;
  else if (last) status = `已連結，上次備份：${last}`;
  else status = '已連結，尚未備份';
  return `<div class="card"><div class="card-body"><h4 style="margin-top:0">☁️ 雲端同步（Google 雲端硬碟）</h4>
    ${cloudState.email ? `<p style="margin:0 0 4px;color:var(--muted)">帳號：${esc(cloudState.email)}</p>` : ''}
    <p ${cls} style="margin:0 0 12px">${esc(status)}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-action="cloud-backup" ${busy}>⬆️ 立即備份</button>
      <button class="ghost" data-action="cloud-restore" ${busy}>⬇️ 從雲端還原…</button>
      <button class="ghost" data-action="cloud-switch" ${busy}>🔄 更換帳號</button>
      <button class="ghost" data-action="cloud-disconnect" ${busy}>解除連結</button>
      <button class="ghost" data-action="cloud-diagnose" ${busy}>🔍 診斷</button>
    </div>
    <p class="hint" style="color:var(--muted);margin-top:10px">自動備份：每次變更會在數秒後自動上傳。多裝置：開啟 App 時若雲端較新會詢問是否還原。歷史版本：每天首次變更保留一份、最多 7 份。</p>
  </div></div>`;
}

/* ==========================================================================
   Events
   ========================================================================== */
const clickHandlers = {
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'modal-close': closeModal,
  'modal-save': () => { const r = modalOnSave ? modalOnSave() : true; if (r !== false) closeModal(); },

  'add-room': () => roomModal(null),
  'edit-room': el => roomModal(roomById(el.dataset.id)),
  'del-room': el => delRoom(el.dataset.id),

  'add-subject': () => { if (!state.domainsConfirmed) { toast('請先完成領域節數設定'); return; } subjectModal(null); },
  'edit-subject': el => subjectModal(subjectById(el.dataset.id)),
  'del-subject': el => delSubject(el.dataset.id),
  'pref-am': () => document.querySelectorAll('.s-prefper').forEach(el => { el.checked = isMorningPeriod(el.value); }),
  'pref-pm': () => document.querySelectorAll('.s-prefper').forEach(el => { el.checked = !isMorningPeriod(el.value); }),
  'pref-clear': () => document.querySelectorAll('.s-prefper').forEach(el => { el.checked = false; }),

  'add-teacher': () => teacherModal(null),
  'edit-teacher': el => teacherModal(teacherById(el.dataset.id)),
  'del-teacher': el => delTeacher(el.dataset.id),
  'check-staffing': () => staffingReportModal(),
  'toggle-matrix': () => { showLoadMatrix = !showLoadMatrix; render(); },
  'goto-teachers': () => { currentTab = 'teachers'; render(); },
  'goto': el => { const t = el.dataset.goto; if (t) { currentTab = t; render(); } },
  'help': () => helpModal(),
  'backup': () => backupMenu(),
  'toggle-avail': el => { el.classList.toggle('off'); el.textContent = el.classList.contains('off') ? '✕' : ''; },
  'add-load-row': () => { syncLoadFromDOM(); const cid = state.classes[0] ? state.classes[0].id : ''; const idx = modalLoad.length; modalLoad.push({ classId: cid, subjectId: firstAvailableSubject(cid, idx), hours: 0 }); refreshLoadEditor(); updateLoadSum(); },
  'del-load-row': el => { syncLoadFromDOM(); modalLoad.splice(parseInt(el.dataset.idx, 10), 1); refreshLoadEditor(); updateLoadSum(); },

  'add-domain': () => { subjDomainOpen = true; state.domains.push({ id: uid(), name: '新領域', hours: [0, 0, 0, 0, 0, 0] }); save(); render(); },
  'del-domain': el => {
    const d = domainById(el.dataset.id); if (!d) return;
    const used = state.subjects.filter(s => s.domainId === d.id);
    subjDomainOpen = true;
    confirmDelete(`刪除領域「${d.name}」？${used.length ? '（' + used.length + ' 個科目將變回未分類）' : ''}`, () => {
      state.subjects.forEach(s => { if (s.domainId === d.id) s.domainId = ''; });
      state.domains = state.domains.filter(x => x.id !== d.id);
    });
  },
  'confirm-domains': () => { state.domainsConfirmed = true; subjDomainOpen = false; save(); render(); toast('領域設定完成，可開始新增科目'); },

  'add-class': () => classModal(null),
  'edit-class': el => classModal(classById(el.dataset.id)),
  'del-class': el => delClass(el.dataset.id),
  'class-detail': el => classDetailModal(classById(el.dataset.id)),

  'sel-grade': el => { selectedGradeId = el.dataset.id; render(); },
  'grade-subj-off': el => {
    const g = gradeById(el.dataset.gid); if (!g) return;
    g.subjectHours = g.subjectHours.filter(x => x.subjectId !== el.dataset.sid);
    save(); render();
  },
  'toggle-gradeday': el => {
    const g = gradeById(el.dataset.gid); if (!g) return;
    const pid = el.dataset.pid, d = parseInt(el.dataset.day, 10);
    g.periodDays[pid] = g.periodDays[pid] || [];
    if (g.periodDays[pid].includes(d)) g.periodDays[pid] = g.periodDays[pid].filter(x => x !== d);
    else g.periodDays[pid].push(d);
    save(); render();
  },

  'add-period': () => { state.settings.periods.push({ id: uid(), label: '新節次', start: '00:00', end: '00:00', isBreak: false }); save(); render(); },
  'del-period': el => {
    const pid = el.dataset.pid;
    state.settings.periods = state.settings.periods.filter(p => p.id !== pid);
    state.grades.forEach(g => { delete g.periodDays[pid]; });
    for (const k in state.slots) if (k.endsWith('|' + pid)) delete state.slots[k];
    save(); render();
  },
  'move-period-up': el => movePeriod(el.dataset.pid, -1),
  'move-period-down': el => movePeriod(el.dataset.pid, 1),

  'auto-schedule': () => autoScheduleModal(),
  'staged-schedule': () => stagedScheduleModal(),
  'run-stage': (el) => runStage(el.dataset.stage),
  'clear-schedule': () => clearScheduleModal(),
  'undo-schedule': () => doUndo(),
  'redo-schedule': () => doRedo(),
  'flex-overview': () => flexOverviewModal(),
  'new-school-year': () => {
    const cur = (state.settings || {}).reportYear || '';
    const nextYr = String((parseInt(cur, 10) || 0) + 1);
    openModal({
      title: '另存為新學年（沿用設定）',
      body: `<p style="margin-top:0">保留<b>科目／年級／班級（含代號、協同）／教師（含配課、導師、Email）／教室／領域／設定</b>，開始新學年排課。</p>
        <label class="field" style="max-width:200px"><span>新學年度</span><input type="text" id="nyYear" value="${esc(nextYr)}" style="width:120px"></label>
        <label class="checkbox" style="margin:10px 0"><input type="checkbox" id="nyKeep"> 保留現有排課當新學年<b>底稿</b>（不勾＝清空排課重排）</label>
        <p class="hint" style="color:var(--muted)">套用前會<b>自動下載一份目前資料備份</b>以防萬一。鎖定／導師自編／線上填課狀態都會重置。</p>`,
      saveLabel: '下載備份並套用', onSave: () => {
        const ny = ($('#nyYear').value || '').trim(); const keep = $('#nyKeep').checked;
        try { exportJSON(); } catch (e) {}                       // 先自動備份目前資料
        state.settings.reportYear = ny;
        if (!keep) { state.slots = {}; state.slotTeachers = {}; state.slotContent = {}; }
        state.locked = false; state.lockedCells = []; state.lockFinalized = false; state.selfReleased = false;
        state.selfCells = []; state.selfBackup = {}; state.selfDone = {}; state.fillShare = null;
        clearUndo(); save(); render();
        toast('已建立新學年（' + ny + '）' + (keep ? '，保留排課底稿' : '，排課已清空'));
        return true;
      },
    });
  },
  'select-subject': el => {
    const sid = el.dataset.id; const tid = el.dataset.teacher || null;
    if (selectedSubjectId === sid && selectedTeacherId === tid) { selectedSubjectId = null; selectedTeacherId = null; }
    else { selectedSubjectId = sid; selectedTeacherId = tid; }
    render();
  },
  'cell-click': el => {
    const key = el.dataset.key; const [classId, day, period] = key.split('|'); const dNum = parseInt(day, 10);
    if (lockMode) {   // 單格鎖定選取中：點格切換鎖定（級任導師任課的自編格不可鎖）
      if (isSelfSlot(key)) { toast('此格為級任導師任課，將自動判為導師自編，免鎖定'); return; }
      const arr = state.lockedCells || (state.lockedCells = []);
      const i = arr.indexOf(key); if (i >= 0) arr.splice(i, 1); else arr.push(key);
      save(); render(); return;
    }
    if (state.lockFinalized) {   // 已定稿
      if (isSelfCell(key)) {                                                  // 自編格→導師選課
        if (selfCellTeacherLocked(key)) { toast('此格已鎖定（導師自編完成或協同連動）；要重選請由排課者按「解鎖導師自編」'); return; }
        selfCellPickModal(key); return;
      }
      if (cellIsLocked(key)) { toast('此格已鎖定，要調整請先解除鎖定'); return; }
      // 單格模式未鎖的格：排課人員仍可自由編輯 → 往下正常流程
    }
    if (state.slots[key]) {
      pushUndo();
      const sid = state.slots[key];
      delete state.slots[key]; delete state.slotTeachers[key]; delete state.slotContent[key];
      const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
      if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid).forEach(p => { const mk = slotKey(p.id, day, period); if (state.slots[mk] === sid) { delete state.slots[mk]; delete state.slotTeachers[mk]; } });
      save(); render(); return;
    }
    if (!selectedSubjectId) { cellSuggestModal(classId, day, period); return; }
    const sid = selectedSubjectId; const s = subjectById(sid); const tid = selectedTeacherId;
    if (s && s.splitTeachers && !tid) { toast('分節上課請在左側選擇「哪位老師」的色塊再放課'); return; }
    const notes = placeWithExtras(classId, day, period, sid, tid);
    render(); if (notes.length) toast(notes.join('；'));
  },
  'place-suggestion': el => {
    const [classId, day, period] = el.dataset.key.split('|');
    const notes = placeWithExtras(classId, day, period, el.dataset.sid, el.dataset.teacher || null);
    closeModal(); render(); if (notes.length) toast(notes.join('；'));
  },
  'suggest-swap': el => swapSuggestModal(selectedClassId, el.dataset.id, el.dataset.teacher || null),

  'lock-schedule': () => openModal({ title: '一鍵鎖定課表', saveLabel: '鎖定', body: `<p style="margin-top:0">整表定稿：<b>所有非自編格變唯讀</b>（不能放課/移除/自動排課）。<b>自編格會釋放為空白</b>，開放導師點選可自排課程。</p><p style="color:var(--muted)">隨時可再「解除鎖定」回到自由編輯。</p>`, onSave: () => { state.locked = true; finalizeLock(); save(); render(); toast('已一鍵鎖定，自編格已釋放'); return true; } }),
  'lockcell-mode': () => { lockMode = true; render(); toast('點課表上要鎖定的格'); },
  'lockcell-cancel': () => { lockMode = false; render(); },
  'lockcell-done': () => openModal({ title: '完成鎖定', saveLabel: '完成鎖定', body: `<p style="margin-top:0">將以目前選取的 <b>${(state.lockedCells || []).length}</b> 格為鎖定範圍定稿：這些格變唯讀，其餘非自編格仍可編。<b>自編格會釋放為空白</b>，開放導師點選課程。</p><p style="color:var(--muted)">隨時可「解除鎖定」回到自由編輯。</p>`, onSave: () => { lockMode = false; finalizeLock(); save(); render(); toast('已完成鎖定，自編格已釋放'); return true; } }),
  'unlock-schedule': () => openModal({ title: '解除鎖定', saveLabel: '解除鎖定', body: `<p style="margin-top:0">解除後可再自由調整排課（放課／移除／自動排課）。<b>已釋放的自編格會還原成鎖定前的原排課</b>——導師這一輪的自選將捨棄。</p>`, onSave: () => { restoreSelfCells(); state.locked = false; state.lockFinalized = false; state.lockedCells = []; lockMode = false; save(); render(); toast('已解除鎖定，自編格已還原原排課'); return true; } }),
  'self-done': el => {
    const cls = el.dataset.cls; const v = validateSelfEdit(cls);
    if (!v.ok) { toast('無法完成導師自編：' + v.reason); return; }
    const name = (classById(cls) || {}).name || '本班';
    openModal({ title: '導師自編完成', saveLabel: '完成並鎖定', body: `<p style="margin-top:0">將鎖定「<b>${esc(name)}</b>」的導師自編選課（變唯讀）。若某格為協同教學，會<b>一併鎖定夥伴班該格</b>；夥伴班導師仍須各自按自己班的「導師自編完成」。</p><p style="color:var(--muted)">要重新選課，需由排課者按「解鎖導師自編」。</p>`, onSave: () => { state.selfDone[cls] = true; save(); render(); toast('已鎖定本班導師自編'); return true; } });
  },
  'self-unlock': el => {
    const cls = el.dataset.cls; const name = (classById(cls) || {}).name || '本班';
    openModal({ title: '解鎖導師自編', saveLabel: '解鎖', body: `<p style="margin-top:0">解除「<b>${esc(name)}</b>」的導師自編鎖定，導師可重新選課。若含協同教學的自編格，會<b>一併解鎖連動的夥伴班該格</b>。</p>`, onSave: () => { delete state.selfDone[cls]; save(); render(); toast('已解鎖導師自編'); return true; } });
  },
  'fill-manage': () => fillManageModal(),
  'open-fill': () => openFillShare(false),
  'reopen-fill': () => confirmDelete('重新開放會為各班建立新的填課檔（舊檔仍留在你的雲端硬碟，可自行刪除）。確定？', () => openFillShare(true)),
  'collect-fill': () => collectFill(),
  'refresh-fillprogress': () => refreshFillProgress(),
  'copy-unsubmitted': () => copyUnsubmittedList(),
  'teacher-fill': () => teacherFillStart(),
  'tfill-cell': el => teacherPickModal(el.dataset.key),
  'tfill-pick': el => { teacherPacket.content[el.dataset.key] = el.dataset.sid; closeModal(); render(); },
  'tfill-clear': el => { delete teacherPacket.content[el.dataset.key]; closeModal(); render(); },
  'tfill-save': () => teacherSaveFill(),
  'tfill-exit': () => {
    const unsaved = teacherPacket && JSON.stringify(teacherPacket.content) !== teacherSavedJson;
    const go = () => {
      teacherPacket = null; teacherFileId = null;
      if (fillLinkMode) { fillEnded = true; render(); try { window.close(); } catch (e) {} }   // 連結進入者：結束畫面＋嘗試關閉分頁，永不進入系統
      else { currentTab = 'settings'; setKiosk(false); }                                        // 排課者本機測試：回設定頁
    };
    if (unsaved) openModal({ title: '尚未儲存', body: '<p style="margin-top:0">你有<b>未儲存</b>的選課變更，離開將<b>不會上傳雲端</b>。</p>', saveLabel: '仍要離開', onSave: () => { go(); return true; } });
    else go();
  },
  'teacher-relogin': () => { fillEnded = false; teacherFillStart(); },
  'pick-selfcourse': el => {
    const key = el.dataset.key, sid = el.dataset.sid; const [classId, day, period] = key.split('|');
    if (selfCellTeacherLocked(key)) { toast('此格已鎖定'); return; }
    if (state.slots[key] !== sid && selfCoursePlaced(classId, sid) >= selfCourseTarget(classId, sid)) { toast('該科已達可自編節數'); return; }
    pushUndo();
    state.slots[key] = sid;
    // 分節上課(✂️)科目：自編格由本班級任導師任教，需記錄授課老師，否則顯示「未指定老師」
    const sSubj = subjectById(sid), hrT = homeroomTeacher(classId);
    if (sSubj && sSubj.splitTeachers && hrT) state.slotTeachers[key] = hrT.id; else delete state.slotTeachers[key];
    // v09.00 協同連動：夥伴班同格（同為自編格、未鎖、空）一併填入
    const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
    if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid).forEach(p => {
      const mk = slotKey(p.id, day, period);
      if (isSelfCell(mk) && !selfCellTeacherLocked(mk) && !state.slots[mk]) state.slots[mk] = sid;
    });
    closeModal(); save(); render(); toast('已選課' + (gid ? '（協同已連動夥伴班）' : ''));
  },
  'clear-selfcell': el => {
    const key = el.dataset.key; const [classId, day, period] = key.split('|');
    if (selfCellTeacherLocked(key)) { toast('此格已鎖定'); return; }
    pushUndo();
    const sid = state.slots[key];
    delete state.slots[key]; delete state.slotTeachers[key];
    // v09.00 協同連動：夥伴班同格（同為自編格、未鎖、同科）一併清空
    if (sid) { const c = classById(classId); const gid = c && c.coteach && c.coteach[sid];
      if (gid) state.classes.filter(x => x.id !== classId && x.coteach && x.coteach[sid] === gid).forEach(p => {
        const mk = slotKey(p.id, day, period);
        if (isSelfCell(mk) && !selfCellTeacherLocked(mk) && state.slots[mk] === sid) { delete state.slots[mk]; delete state.slotTeachers[mk]; }
      }); }
    closeModal(); save(); render(); toast('已清空');
  },

  'print-out': () => {
    let styleEl = null;
    if (outputMode === 'school' || outputMode === 'schoolTeacher') {  // 全校總表：暫時切橫向紙張列印
      styleEl = document.createElement('style');
      styleEl.textContent = '@page{size:landscape;margin:8mm}';
      document.head.appendChild(styleEl);
    }
    const cleanup = () => { if (styleEl) { styleEl.remove(); styleEl = null; } };
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    setTimeout(cleanup, 2000);
  },
  'master-png': () => masterPNG(outputMode),
  'csv-out': exportCSV,
  'all-class-docx': exportAllClassDocx,
  'all-teacher-docx': exportAllTeacherDocx,

  'export-json': exportJSON,
  'import-json': importJSON,

  'cloud-connect': () => cloudConnect(),
  'reset-app': () => resetThisAppData(),
  'cloud-backup': () => cloudBackupNow({ manual: true, interactive: true }),
  'cloud-restore': () => openRestorePicker(),
  'cloud-switch': () => cloudSwitchAccount(),
  'cloud-disconnect': () => cloudDisconnect(),
  'cloud-diagnose': () => cloudDiagnose(),

  'subst-add': () => substAddModal(),
  'subst-submaster': () => substSubMasterModal(),               // v10.14 代課老師合併總表
  'subst-submaster-print': () => substSubMasterPrint(),
  'subst-dates': el => substEditDates(el.dataset.id),
  'subst-per-preset': el => {   // v10.13 請假節次快速鍵：全天/上午/下午
    const preset = el.dataset.preset; const { am, pm } = amPmPeriods();
    const want = preset === 'am' ? new Set(am.map(String)) : preset === 'pm' ? new Set(pm.map(String)) : null;
    document.querySelectorAll('.subst-per-chk').forEach(chk => { chk.checked = want ? want.has(chk.value) : true; });
  },
  'subst-open': el => { substOpenId = el.dataset.id; substWeekTab = null; render(); },
  'subst-back': () => { substOpenId = null; substWeekTab = null; render(); },
  'subst-del': el => { if (substKiosk) return; substDelete(el.dataset.id); },   // kiosk 不可刪
  'subst-week-tab': el => { substWeekTab = el.dataset.w === 'all' ? null : Number(el.dataset.w); render(); },   // v10.16 分週指派切換
  'subst-cell': el => { const id = el.dataset.id; if (substKiosk && !substEditableIds.has(id)) { toast('此為他人填報的代課，僅供檢視'); return; } const w = el.dataset.week; substCellPicker(id, el.dataset.key, el.dataset.day, el.dataset.period, (w == null || w === 'all') ? null : Number(w)); },
  'subst-clear': el => { const r = substById(el.dataset.id); if (r) { delete r.assignments[el.dataset.key]; save(); closeModal(); render(); } },
  'subst-clear-override': el => { const r = substById(el.dataset.id); if (r && r.weekOverrides) { delete r.weekOverrides[el.dataset.week + '|' + el.dataset.key]; save(); closeModal(); render(); } },   // v10.16 改回沿用全部週
  'subst-print': () => substPrint(),
  // v10.01 線上代課填報
  'subst-share-manage': () => substShareModal(),
  'open-subst': () => openSubstShare(),
  'collect-subst': () => collectSubst(),   // v10.08 收回＝合併＋重新開放（覆蓋快照＋補分享）
  'subst-login': () => substKioskStart(),
  'subst-submit': el => substSubmit(substById(el.dataset.id)),
  'subst-kiosk-exit': () => { substEnded = true; render(); try { window.close(); } catch (e) {} },
};

const changeHandlers = {
  'day-toggle': el => {
    const d = parseInt(el.dataset.day, 10);
    if (el.checked) { if (!state.settings.days.includes(d)) state.settings.days.push(d); }
    else state.settings.days = state.settings.days.filter(x => x !== d);
    save(); render();
  },
  'period-field': el => { const p = byId(state.settings.periods, el.dataset.pid); if (p) { p[el.dataset.field] = el.value; save(); } },
  'period-break': el => { const p = byId(state.settings.periods, el.dataset.pid); if (p) { p.isBreak = el.checked; save(); render(); } },
  'set-maxperday': el => { state.settings.maxLessonsPerDay = parseInt(el.value, 10) || 0; save(); },
  'report-field': el => { state.settings[el.dataset.field] = el.value; save(); },
  'subjmap-field': el => { if (!state.settings.subjectMap) state.settings.subjectMap = {}; const v = el.value.trim(); if (v === '') delete state.settings.subjectMap[el.dataset.subj]; else state.settings.subjectMap[el.dataset.subj] = v; save(); },
  'domain-name': el => { const d = domainById(el.dataset.id); if (d) { subjDomainOpen = true; d.name = el.value; save(); render(); } },
  'domain-hours': el => {
    const d = domainById(el.dataset.id); if (!d) return;
    if (!Array.isArray(d.hours)) d.hours = [0, 0, 0, 0, 0, 0];
    subjDomainOpen = true;
    d.hours[parseInt(el.dataset.grade, 10)] = parseInt(el.value, 10) || 0;
    save(); render();
  },
  'load-class': el => {
    syncLoadFromDOM();
    const idx = parseInt(el.dataset.idx, 10);
    modalLoad[idx].classId = el.value;
    modalLoad[idx].subjectId = firstAvailableSubject(el.value, idx);
    modalLoad[idx].hours = 0;
    refreshLoadEditor(); updateLoadSum();
  },
  'load-subject': el => {
    syncLoadFromDOM();
    const idx = parseInt(el.dataset.idx, 10);
    modalLoad[idx].subjectId = el.value;
    // 換科目後把超過新剩餘的節數夾回上限
    const rem = remainingForRow(modalLoad[idx].classId, el.value, idx);
    if ((modalLoad[idx].hours || 0) > rem) modalLoad[idx].hours = rem;
    refreshLoadEditor(); updateLoadSum();
  },
  'teacher-type': el => { const f = $('#homeroomField'); if (f) f.style.display = el.value === '級任' ? '' : 'none'; },
  'load-hours': el => {
    syncLoadFromDOM();
    const idx = parseInt(el.dataset.idx, 10);
    const L = modalLoad[idx]; if (L) {
      const rem = remainingForRow(L.classId, L.subjectId, idx);
      if ((L.hours || 0) > rem) { L.hours = rem; toast(`「${subjectName(L.subjectId)}」最多只能再配 ${rem} 節`); }
    }
    refreshLoadEditor(); updateLoadSum();
  },
  'weekly-hours': () => updateLoadSum(),
  'schedule-class': el => { selectedClassId = el.value; selectedSubjectId = null; selectedTeacherId = null; render(); },
  'flex-teacher': el => { flexTeacherId = el.value; flexOverviewModal(); },
  'out-mode': el => { outputMode = el.value; render(); },
  'out-class': el => { outputClassId = el.value; render(); },
  'out-teacher': el => { outputTeacherId = el.value; render(); },

  'grade-subj-on': el => {
    const g = gradeById(el.dataset.gid); if (!g) return;
    const sid = el.dataset.sid;
    if (el.checked) { if (!gradeSubjHours(g, sid)) g.subjectHours.push({ subjectId: sid, hours: 0 }); }
    else g.subjectHours = g.subjectHours.filter(x => x.subjectId !== sid);
    save(); render();
  },
  'grade-subj-hours': el => {
    const g = gradeById(el.dataset.gid); if (!g) return;
    const sh = gradeSubjHours(g, el.dataset.sid); if (!sh) return;
    sh.hours = parseInt(el.value, 10) || 0;
    save();
    // 只更新總計徽章，避免輸入中重繪打斷
    const badge = $('.total-badge');
    if (badge) { const av = gradeAvailableSlots(g), as = gradeAssignedHours(g), m = av === as;
      badge.className = 'total-badge ' + (m ? 'ok' : 'bad');
      badge.innerHTML = `已配 <b>${as}</b> / 應配 <b>${av}</b> 節　${m ? '✓ 相符' : (as > av ? '✗ 超過 ' + (as - av) + ' 節' : '✗ 還差 ' + (av - as) + ' 節')}`;
    }
    // 更新年級分頁的 ✓
    document.querySelectorAll('.gtab').forEach(b => {
      if (b.dataset.id === g.id) { const c = b.querySelector('.ok-check'); const done = gradeComplete(g);
        if (done && !c) b.insertAdjacentHTML('beforeend', ' <span class="ok-check">✓</span>');
        if (!done && c) c.remove(); }
    });
  },
};

function bindGlobal() {
  document.addEventListener('click', e => { const el = e.target.closest('[data-action]'); if (!el) return; const fn = clickHandlers[el.dataset.action]; if (fn) fn(el, e); });
  // 追蹤摺疊區展開狀態（toggle 不會冒泡 → 用捕獲階段），讓重繪後保持使用者的展開/收合
  document.addEventListener('toggle', e => {
    const d = e.target; if (!(d instanceof HTMLDetailsElement)) return;
    if (d.classList.contains('domain-fold')) subjDomainOpen = d.open;
    else if (d.classList.contains('grade-fold')) gradeFoldOpen = d.open;
  }, true);
  document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (!el) return; const fn = changeHandlers[el.dataset.change]; if (fn) fn(el, e); });
  document.addEventListener('keydown', e => {   // v09.11 排課復原：Ctrl+Z 復原、Ctrl+Y/Ctrl+Shift+Z 重做（僅④排課、非輸入中、非 kiosk）
    if (kioskFill || substKiosk || currentTab !== 'schedule' || lockMode) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });
  const vt = $('#versionTag'); if (vt) vt.textContent = APP_VERSION;
}

function upgradeNoticeModal() {
  openModal({ title: '系統改版通知', body: `<div class="help-note" style="margin:0">課務編排系統全面改版，先前的設定內容無法相容，改版後所有資料將會清除。已開啟使用過的同仁，請重新整理網頁，重新開始建置。</div>` });
}

// v10.19 全新安裝初次設定精靈：填入貴校基本資料 → 立即套用到首頁抬頭與課表輸出（日後仍可於「設定」修改）
function setupModal() {
  const s = state.settings || {};
  openModal({
    title: '歡迎使用課務編排 · 初次設定',
    saveLabel: '開始使用',
    body: `<div class="help-note" style="margin:0 0 16px">先填入貴校基本資料，<b>首頁抬頭與課表輸出會立即套用</b>；日後可在「設定」隨時修改。</div>
      <div class="setup-fields">
        <label class="field"><span>校名</span><input type="text" id="setupSchool" value="${esc(s.reportSchool || '')}" placeholder="請輸入貴校校名"></label>
        <label class="field"><span>學年度</span><input type="text" id="setupYear" value="${esc(s.reportYear || '')}" placeholder="如 114"></label>
        <label class="field"><span>學校代號</span><input type="text" id="setupCode" value="${esc(s.schoolCode || '')}" placeholder="msd9" title="導師線上填課的雲端檔名前綴；多校共用雲端時各校自填以區隔，單校可留預設"></label>
      </div>
      <div class="hint" style="margin-top:10px;color:var(--muted)">學校代號僅用於「導師線上填課」的雲端檔名前綴，單一學校可沿用預設。</div>`,
    onSave: () => {
      state.settings.reportSchool = ($('#setupSchool').value || '').trim();
      state.settings.reportYear = ($('#setupYear').value || '').trim();
      const code = ($('#setupCode').value || '').trim();
      if (code) state.settings.schoolCode = code;
      save(); render();
      toast('已套用貴校資料，可隨時在「設定」修改');
      if (!state.helpSeen) { state.helpSeen = true; save(); setTimeout(helpModal, 0); }   // 設定完成後接著顯示使用說明（一次）
      return true;
    }
  });
}

/* ---------- Init ---------- */
async function init() {
  // v10.05 救援入口：畫面卡到連設定都點不到時，開 …/index.html?reset=1 只重設本 App。
  // 放在最前面、任何雲端/token 邏輯之前，確保這條路永遠不會被授權迴圈卡住。
  if (new URLSearchParams(location.search).has('reset')) { await resetThisAppData(); return; }
  let loaded = null;
  try { loaded = await idbGet(STATE_KEY); } catch (e) { loaded = null; }
  const hadOldData = !!(loaded && loaded.schema !== SCHEMA);
  if (!loaded || loaded.schema !== SCHEMA) { state = defaultState(); await save(); }
  else { state = loaded; if (!Array.isArray(state.rooms)) state.rooms = []; if (!state.slotTeachers || typeof state.slotTeachers !== 'object') state.slotTeachers = {}; } // v02 教室加回；v02.02 分節上課
  if (!state.slotContent || typeof state.slotContent !== 'object') state.slotContent = {};   // v08.00 自編課程內容
  if (!Array.isArray(state.lockedCells)) state.lockedCells = [];                              // v08.02 單格鎖定
  if (!Array.isArray(state.selfCells)) state.selfCells = [];                                  // v08.03 自編偵測
  if (!state.selfBackup || typeof state.selfBackup !== 'object') state.selfBackup = {};       // v09.00 釋放前備份
  if (!state.selfDone || typeof state.selfDone !== 'object') state.selfDone = {};             // v09.00 導師自編完成
  if (typeof state.staffingOkSig !== 'string') state.staffingOkSig = '';                      // v09.01 配課檢查簽章
  if (!Array.isArray(state.substitutions)) state.substitutions = [];                          // v09.45 代課安排
  if (!Array.isArray(state.substDeleted)) state.substDeleted = [];                            // v10.12 代課刪除墓碑
  normalizeAllSubst();                                                                        // v10.06 代課日期遷移（date→startDate/endDate）
  if (typeof state.domainsConfirmed !== 'boolean') state.domainsConfirmed = state.subjects.length > 0; // v09.20 領域→科目整合閘門（既有已建科目者視為已完成，不擋）
  state.subjects.forEach(s => { if (s.selfDesigned) delete s.selfDesigned; });                // v08.03 移除舊手動自編旗標
  // v03.00 課表輸出格式欄位 guard（舊資料補預設）
  // 校名／學年度不再預填任何校別（v10.19 通用化）：留白由排課者於「設定」填入，首頁抬頭以佔位符提示。
  if (typeof state.settings.reportSchool !== 'string') state.settings.reportSchool = '';
  if (typeof state.settings.reportYear !== 'string') state.settings.reportYear = '';
  if (!state.settings.schoolCode) state.settings.schoolCode = 'msd9';                        // v09.09 學校代號（填課檔名前綴，僅內部用於雲端檔名）
  if (typeof state.setupSeen !== 'boolean') state.setupSeen = !!state.settings.reportSchool; // v10.19 既有已填校名者視為已設定過、不再跳精靈
  if (!state.settings.subjectMap || typeof state.settings.subjectMap !== 'object') state.settings.subjectMap = {};
  if (!Array.isArray(state.domains)) state.domains = defaultDomains();                 // v06.00 領域節數參考表
  const pruned = pruneOrphanData();                                                    // v11 自癒：清除已刪班級/科目/教師的殘留（曾致刪班後排課頁崩潰＝看似鎖死）
  if (pruned) { save(); }
  bindGlobal();
  render();
  const params = new URLSearchParams(location.search);
  const fillMode = params.has('fill');                                     // v09.03 導師填課入口（排課老師發的連結）
  const substMode = params.has('subst');                                   // v10.01 代課填報入口（排課老師發的連結）
  if (fillMode) { fillLinkMode = true; setKiosk(true); }                    // v09.05/07 導師 kiosk：只顯示填課介面；連結進入者離開＝結束、不進系統
  else if (substMode) { substLinkMode = true; setSubstKiosk(true); }        // v10.01 代課 kiosk：只顯示代課填報；離開＝結束、不進系統
  else if (hadOldData) upgradeNoticeModal();                              // 舊版同仁：改版通知
  else if (!state.setupSeen) { state.setupSeen = true; save(); setupModal(); } // 全新安裝：初次設定精靈（校名/學年度/代號）→ 內部再串使用說明
  else if (!state.helpSeen) { helpModal(); state.helpSeen = true; save(); } // 新同仁：使用說明
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // v07.00 雲端同步：開 App 若雲端較新則詢問還原；回前景再檢查一次
  if (cloudState.enabled && cloudConfigured()) { cloudCheckOnOpen(); refreshCloudEmailIfMissing(); }
  document.addEventListener('visibilitychange', () => {
    // v10.05 節流：回前景至少隔 5 分鐘、且本 session 未因失敗停用，才再自動查一次，避免回前景即重觸發的迴圈。
    if (document.visibilityState === 'visible' && cloudState.enabled && cloudConfigured()
        && !cloudAutoDisabledThisSession && Date.now() - cloudLastCheckAt > 5 * 60 * 1000) cloudCheckOnOpen();
  });
}
init();
