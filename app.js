'use strict';

/* ==========================================================================
   課務編排 v02（redesign）— 前後參照流程
   科目 → 年級(節次表+科目節數) → 班級 → 教師(配課) → 排課
   資料層：IndexedDB 單一 state 文件（schema:2）
   ========================================================================== */

const APP_VERSION = 'v09.01';
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
    settings: { days, periods, autoPairConsecutive: true, reportSchool: '臺東縣成功鎮三民國民小學', reportYear: '113', subjectMap: {} },
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
    helpSeen: false,
  };
}

async function save() { await idbSet(STATE_KEY, state); scheduleCloudBackup(); maybeDailySnapshot(); }

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

function textOn(hex) {
  const h = hex.replace('#', '');
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
let currentTab = 'subjects';
let selectedGradeId = null;
let lockMode = false;   // v08.02 單格鎖定選取模式進行中（runtime，不持久化）

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

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  const view = $('#view');
  switch (currentTab) {
    case 'subjects': view.innerHTML = viewSubjects(); break;
    case 'grades': view.innerHTML = viewGrades(); break;
    case 'classes': view.innerHTML = viewClasses(); break;
    case 'teachers': view.innerHTML = viewTeachers(); break;
    case 'domains': view.innerHTML = viewDomains(); break;
    case 'schedule': view.innerHTML = viewSchedule(); break;
    case 'output': view.innerHTML = viewOutput(); break;
    case 'settings': view.innerHTML = viewSettings(); break;
  }
}

/* ==========================================================================
   ① 科目
   ========================================================================== */
function viewSubjects() {
  const head = `<div class="page-head"><h2>① 科目</h2><button class="btn" data-action="add-subject">＋ 新增科目</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">先建立全校要開的科目，並選教學型態：<b>單一教師</b>整科一位老師；<b>👥 分組教學</b>同班多師「同一節」平行上；<b>✂️ 分節上課</b>多師分攤節數、各上「不同節」（如生活 6 節＝A 上 4＋B 上 2）。</div>`;
  if (state.subjects.length === 0) return head + emptyCard('尚無科目', '例如：國語、數學、英語、自然、體育、藝術…');
  const modePill = s => s.splitTeachers ? '<span class="pill teal">✂️ 分節上課</span>' : s.allowGrouping ? '<span class="pill amber">👥 分組教學</span>' : '<span style="color:var(--muted)">單一教師</span>';
  const lockText = s => {
    const parts = [];
    if ((s.lockDays || []).length) parts.push(s.lockDays.slice().sort((a, b) => a - b).map(d => DAY_LABELS[d]).join('/'));
    if ((s.lockPeriods || []).length) parts.push(s.lockPeriods.map(pid => (byId(state.settings.periods, pid) || {}).label || pid).join('/'));
    return parts.length ? `<span class="pill gray">🔒 ${esc(parts.join('｜'))}</span>` : '<span style="color:var(--muted)">—</span>';
  };
  const domainCell = s => {
    if (!s.domainId || !domainById(s.domainId)) return '<span style="color:var(--warn)">未分類</span>';
    return `<span class="pill gray">${esc(domainName(s.domainId))}</span>`;
  };
  const rows = state.subjects.map(s => `<tr>
    <td><span class="pill" style="background:${s.color};color:${textOn(s.color)}">${esc(s.name)}</span></td>
    <td>${domainCell(s)}</td>
    <td>${modePill(s)}</td>
    <td>${s.consecutive ? '<span class="pill blue">⏱ 需連堂</span>' : '<span style="color:var(--muted)">—</span>'}</td>
    <td>${lockText(s)}</td>
    <td class="row-actions">
      <button class="icon-btn" data-action="edit-subject" data-id="${s.id}">✏️</button>
      <button class="icon-btn" data-action="del-subject" data-id="${s.id}">🗑️</button>
    </td></tr>`).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>科目</th><th>領域</th><th>教學型態</th><th>連堂</th><th>排課限制</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function subjectModal(existing) {
  const s = existing || { name: '', color: COLORS[state.subjects.length % COLORS.length], domainId: '', allowGrouping: false, splitTeachers: false, consecutive: false, lockDays: [], lockPeriods: [] };
  const mode = s.splitTeachers ? 'split' : s.allowGrouping ? 'group' : 'single';
  const domainOpts = `<option value="">（未分類）</option>` +
    state.domains.map(d => `<option value="${d.id}" ${s.domainId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const lockDays = new Set(s.lockDays || []);
  const lockPeriods = new Set(s.lockPeriods || []);
  const dayChecks = activeDays().map(d => `<label class="checkbox chk-inline"><input type="checkbox" class="s-lockday" value="${d}" ${lockDays.has(d) ? 'checked' : ''}> ${DAY_LABELS[d]}</label>`).join('');
  const perChecks = lessonPeriods().map(p => `<label class="checkbox chk-inline"><input type="checkbox" class="s-lockper" value="${p.id}" ${lockPeriods.has(p.id) ? 'checked' : ''}> ${esc(p.label)}</label>`).join('');
  openModal({
    title: existing ? '編輯科目' : '新增科目',
    body: `
      <div class="field-row">
        <label class="field" style="flex:2"><span>科目名稱</span><input type="text" id="sName" value="${esc(s.name)}"></label>
        <label class="field" style="flex:1"><span>顏色</span><input type="color" id="sColor" value="${s.color}" style="height:40px;padding:2px"></label>
      </div>
      <label class="field" style="margin-bottom:6px"><span>所屬領域（供「領域節數」對照；可留未分類）</span>
        <select id="sDomain">${domainOpts}</select></label>
      <label class="field" style="margin-bottom:6px"><span>教學型態</span>
        <select id="sMode">
          <option value="single" ${mode === 'single' ? 'selected' : ''}>單一教師（整科由一位老師上）</option>
          <option value="group" ${mode === 'group' ? 'selected' : ''}>👥 分組教學（同班多師「同一節」平行上，不計衝堂）</option>
          <option value="split" ${mode === 'split' ? 'selected' : ''}>✂️ 分節上課（多師分攤節數、各上「不同節」，如生活 A上4＋B上2）</option>
        </select></label>
      <label class="checkbox" style="margin-bottom:12px"><input type="checkbox" id="sConsec" ${s.consecutive ? 'checked' : ''}> ⏱ 需連堂（排課時兩節相鄰接續上）</label>
      <div class="field" style="margin-bottom:8px"><span>排課限制（給自動排課用；不勾＝不限。手動排課不受限）</span></div>
      <div class="lock-group"><div class="lock-label">只排在這些<b>上課日</b>：</div><div class="chk-row">${dayChecks || '<span style="color:var(--muted)">尚無上課日</span>'}</div></div>
      <div class="lock-group"><div class="lock-label">只排在這些<b>節次</b>：</div><div class="chk-row">${perChecks}</div></div>
      <div class="hint" style="color:var(--muted);font-size:12px;margin-bottom:12px">例：母語只勾「週四」；彈性在地勾「週五」＋「第1節」；體育只勾「第2/3/6/7節」。</div>
      <div class="field" style="margin-bottom:8px"><span>進階排課（給自動排課用）</span></div>
      <label class="checkbox chk-inline" style="margin-right:16px"><input type="checkbox" id="sDistinct" ${s.distinctDays ? 'checked' : ''}> 每天最多 1 節（多節分散不同天）</label>
      <label class="checkbox chk-inline"><input type="checkbox" id="sGap" ${s.gapDays ? 'checked' : ''}> 兩節不排相鄰兩天（隔天以上，如體育）</label>
      <label class="field" style="margin-top:10px"><span>偏好時段（軟性，盡量滿足）</span>
        <select id="sBand">
          <option value="any" ${(s.preferBand || 'any') === 'any' ? 'selected' : ''}>不限</option>
          <option value="am" ${s.preferBand === 'am' ? 'selected' : ''}>偏好上午（如主科）</option>
          <option value="pm" ${s.preferBand === 'pm' ? 'selected' : ''}>偏好下午</option>
        </select></label>
      <label class="checkbox" style="margin-top:6px"><input type="checkbox" id="sExCap" ${s.excludeDailyCap ? 'checked' : ''}> 不列入教師單日節數上限（如母語課）</label>
      <div class="hint" style="color:var(--muted);font-size:12px">「每天最多1節/隔天」與「需連堂」互斥（連堂本就同日兩節），設連堂時此兩項自動忽略。</div>`,
    onSave: () => {
      const name = $('#sName').value.trim();
      if (!name) { toast('請輸入科目名稱'); return false; }
      const m = $('#sMode').value;
      const ld = Array.from(document.querySelectorAll('.s-lockday:checked')).map(el => parseInt(el.value, 10));
      const lp = Array.from(document.querySelectorAll('.s-lockper:checked')).map(el => el.value);
      const data = { name, color: $('#sColor').value, domainId: $('#sDomain').value, allowGrouping: m === 'group', splitTeachers: m === 'split', consecutive: $('#sConsec').checked, lockDays: ld, lockPeriods: lp, distinctDays: $('#sDistinct').checked, gapDays: $('#sGap').checked, preferBand: $('#sBand').value, excludeDailyCap: $('#sExCap').checked };
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
function viewGrades() {
  if (state.subjects.length === 0)
    return `<div class="page-head"><h2>② 年級</h2></div>` + emptyCard('請先設定科目', '年級要勾選開課科目並配節數，需先到「① 科目」建立科目。');
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
  // 科目節數
  const subjRows = state.subjects.map(s => {
    const sh = gradeSubjHours(g, s.id); const on = !!sh;
    return `<tr>
      <td><label class="checkbox" style="font-weight:400"><input type="checkbox" data-change="grade-subj-on" data-gid="${g.id}" data-sid="${s.id}" ${on ? 'checked' : ''}>
        <span class="pill" style="background:${s.color};color:${textOn(s.color)}">${esc(s.name)}</span>${s.allowGrouping ? ' 👥' : ''}</label></td>
      <td style="width:130px"><input type="number" min="0" max="40" data-change="grade-subj-hours" data-gid="${g.id}" data-sid="${s.id}" value="${on ? sh.hours : ''}" ${on ? '' : 'disabled'} style="width:90px"> 節</td>
    </tr>`;
  }).join('');

  return `
    <div class="page-head"><h2>② 年級</h2>
      <div class="hint">為每個年級設定「哪些節有課」與「各科一周節數」，兩者總和相符才算完成 ✓。</div>
    </div>
    <div class="gtabs no-print">${nav}</div>
    <div class="grade-cols">
      <div class="card"><div class="card-body">
        <h4 style="margin-top:0">2.1 節次表 — ${esc(g.name)}（點格切換是否上課）</h4>
        <div class="grid-wrap">${grid}</div>
        <p class="hint" style="color:var(--muted);margin-top:8px">可用節格數（打勾總數）：<b>${avail}</b> 節。上課日欄位由「設定 ▸ 上課日」決定；午休等分隔節在「設定 ▸ 節次定義」設。</p>
      </div></div>
      <div class="card"><div class="card-body">
        <h4 style="margin-top:0">2.2 科目節數 — ${esc(g.name)}</h4>
        <table class="data"><tbody>${subjRows}</tbody></table>
        <div class="total-badge ${match ? 'ok' : 'bad'}">
          已配 <b>${assigned}</b> / 應配 <b>${avail}</b> 節　${match ? '✓ 相符' : (assigned > avail ? '✗ 超過 ' + (assigned - avail) + ' 節' : '✗ 還差 ' + (avail - assigned) + ' 節')}
        </div>
      </div></div>
    </div>`;
}

/* ==========================================================================
   ③ 班級（選年級 → 課程強制沿用年級；協同教學）
   ========================================================================== */
const classGrade = c => gradeById(c.gradeId);
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

function viewClasses() {
  const head = `<div class="page-head"><h2>③ 班級</h2><button class="btn" data-action="add-class">＋ 新增班級</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">班級選定年級後，課程（科目與一周節數）自動沿用該年級設定。點「科目 / 協同」可設定各科的協同教學班級（預設同年級同科目）。</div>`;
  if (state.classes.length === 0) return head + emptyCard('尚無班級', '例如：一年忠班、一年孝班。新增後課程沿用其年級。');
  const rows = state.classes.slice().sort((a, b) => (a.gradeId + a.name).localeCompare(b.gradeId + b.name, 'zh-Hant')).map(c => {
    const g = classGrade(c);
    const incomplete = g && !gradeComplete(g);
    const coCount = Object.keys(c.coteach || {}).length;
    return `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${esc(gradeName(c.gradeId))}${incomplete ? ' <span class="pill red" title="該年級科目節數尚未相符">年級未完成</span>' : ''}</td>
      <td>${classSubjectHours(c).length} 科 / ${classWeeklyHours(c)} 節</td>
      <td>${coCount ? `<span class="pill blue">🔗 ${coCount} 科協同</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="row-actions">
        <button class="ghost" data-action="class-detail" data-id="${c.id}" style="padding:5px 10px;font-size:13px">科目 / 協同</button>
        <button class="icon-btn" data-action="edit-class" data-id="${c.id}">✏️</button>
        <button class="icon-btn" data-action="del-class" data-id="${c.id}">🗑️</button>
      </td></tr>`;
  }).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>班級</th><th>年級</th><th>課程</th><th>協同</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function classModal(existing) {
  if (state.grades.length === 0) { openModal({ title: '無法新增', body: '<p>系統應有六個年級，請重整。</p>' }); return; }
  const c = existing || { name: '', gradeId: state.grades[0].id };
  const gradeOpts = state.grades.map(g => `<option value="${g.id}" ${g.id === c.gradeId ? 'selected' : ''}>${esc(g.name)}${gradeComplete(g) ? '' : '（節數未完成）'}</option>`).join('');
  openModal({
    title: existing ? '編輯班級' : '新增班級',
    body: `<label class="field"><span>班級名稱</span><input type="text" id="cName" value="${esc(c.name)}" placeholder="例：一年忠班"></label>
      <label class="field"><span>年級</span><select id="cGrade">${gradeOpts}</select></label>
      <p class="hint" style="color:var(--muted)">課程（科目＋節數）將沿用所選年級於「② 年級」的設定。</p>`,
    onSave: () => {
      const name = $('#cName').value.trim();
      if (!name) { toast('請輸入班級名稱'); return false; }
      const gradeId = $('#cGrade').value;
      if (existing) {
        if (existing.gradeId !== gradeId) removeClassFromAllCoteach(existing.id); // 換年級 → 協同失效
        existing.name = name; existing.gradeId = gradeId;
      } else state.classes.push({ id: uid(), name, gradeId, coteach: {} });
      save(); render(); toast('已儲存班級');
      return true;
    },
  });
}
function classDetailModal(c) {
  const subs = classSubjectHours(c);
  if (subs.length === 0) {
    openModal({ title: `${c.name}`, body: `<p>此班年級（${esc(gradeName(c.gradeId))}）尚未於「② 年級」設定任何科目節數。請先完成年級設定。</p>` });
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
      <td style="white-space:nowrap"><span class="pill" style="background:${s.color};color:${textOn(s.color)}">${esc(s.name)}</span>${s.allowGrouping ? ' 👥' : ''}</td>
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
    for (const k in state.slots) if (k.startsWith(id + '|')) delete state.slots[k];
    state.teachers.forEach(t => { if (t.homeroomClassId === id) t.homeroomClassId = ''; }); // 清除指向此班的導師設定
    state.classes = state.classes.filter(x => x.id !== id);
  });
}

/* ==========================================================================
   ④ 教師 / 教師配課 / 全校交叉檢核
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
    ? `<div class="card"><div class="card-body"><span style="color:var(--muted)">尚無班級，請先完成「③ 班級」。</span></div></div>`
    : `<div class="card"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>${confirmed
          ? '<b style="color:var(--ok)">✓ 全校配課與導師設定已檢查通過</b>　已解鎖 ⑤ 排課。'
          : `<b style="color:var(--danger)">⚠ 尚未通過全校檢查</b>　${problems.length ? `配課問題 ${problems.length} 項；` : ''}${noHr.length ? `未設導師班級 ${noHr.length} 個（${esc(noHr.join('、'))}）；` : ''}${(!problems.length && !noHr.length) ? '資料已齊，請按右側「檢查全校配課」完成確認。' : '修正後請按「檢查全校配課」。'}`}
          <div style="color:var(--muted);font-size:12px;margin-top:4px">⑤ 排課需先在此通過「檢查全校配課」（含每班均已設定級任導師）。</div>
        </div>
        <button class="${confirmed ? 'ghost' : 'btn'}" data-action="check-staffing">檢查全校配課</button>
      </div></div>`;
  const head = `<div class="page-head"><h2>④ 教師</h2><button class="btn" data-action="add-teacher">＋ 新增教師</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">填入教師基本資料與不排課時段，並設定其配課（教哪個班的哪一科幾節）。每位教師配課合計須等於其每周授課時數才可儲存。</div>`;
  if (state.teachers.length === 0) return head + statusCard + emptyCard('尚無教師', '新增教師並設定配課。');
  const rows = state.teachers.map(t => {
    const sum = teacherLoadSum(t); const match = sum === (t.weeklyHours || 0);
    return `<tr>
      <td><b>${esc(t.name)}</b></td>
      <td><span class="pill gray">${esc(t.type || '')}</span>${t.type === '級任' && t.homeroomClassId && classById(t.homeroomClassId) ? `<span class="pill blue" style="margin-left:4px">🎓 ${esc(classById(t.homeroomClassId).name)}導師</span>` : ''}</td>
      <td>${t.weeklyHours || 0} 節</td>
      <td style="color:${match ? 'var(--ok)' : 'var(--danger)'};font-weight:700">${sum} 節 ${match ? '✓' : '✗'}</td>
      <td>${(t.load || []).length} 筆</td>
      <td>${(t.unavailable || []).length ? (t.unavailable.length + ' 個') : '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-action="edit-teacher" data-id="${t.id}">✏️</button>
        <button class="icon-btn" data-action="del-teacher" data-id="${t.id}">🗑️</button>
      </td></tr>`;
  }).join('');
  return head + statusCard + `<div class="card"><table class="data">
    <thead><tr><th>姓名</th><th>身分</th><th>每周授課</th><th>已配</th><th>配課筆數</th><th>不排課</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
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
  if (state.classes.length === 0) return `<div class="hint" style="color:var(--muted)">尚無班級，請先到「③ 班級」建立。</div>`;
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
      <label class="field" id="homeroomField" style="max-width:320px;margin-bottom:6px;display:${t.type === '級任' ? '' : 'none'}"><span>擔任導師的班級（級任）</span><select id="tHomeroom">${hrClsOpts}</select></label>
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
      const data = { name, type, weeklyHours: weekly, maxPerDay: parseInt($('#tMaxDay').value, 10) || 0, homeroomClassId, unavailable, load };
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
  });
}
function staffingReportModal() {
  const problems = checkStaffing();
  const noHr = unsetHomerooms();
  const allClear = problems.length === 0 && noHr.length === 0;
  if (allClear) { state.staffingOkSig = staffingSignature(); save(); render(); }   // 通過→記下簽章、解鎖 ⑤ 排課
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
    ? `<div class="total-badge ok" style="margin-bottom:10px">✓ 全校配課與導師設定皆完成，已解鎖 ⑤ 排課。</div>`
    : `<p style="color:var(--danger);font-weight:700;margin-top:0">尚有問題需修正，修正後請再按一次「檢查全校配課」。</p>`;
  openModal({ title: '全校配課檢查', wide: true, body: head + hrBlock + loadBlock });
}

/* ==========================================================================
   領域節數參考（v06.00）：建議節數參考表（可編輯）＋ 各年級實配對照
   ========================================================================== */
function viewDomains() {
  const grades = state.grades; // g1..g6，順序＝一~六
  const gh = GRADE_NAMES.map(n => `<th style="text-align:center;width:66px">${esc(n.replace('年級', ''))}</th>`).join('');
  const head = `<div class="page-head"><h2>領域節數</h2><button class="btn" data-action="add-domain">＋ 新增領域</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">各領域每年級的<b>建議節數</b>（可編輯）與<b>目前實配</b>對照。實配＝「② 年級」已設科目節數，依「① 科目」所選「所屬領域」加總。<b style="color:var(--warn)">下方預設數字為 108 課綱起點，請務必依課綱／貴校實況校對。</b></div>`;

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
      <b style="color:var(--warn)">未分類科目</b>＝該科在「① 科目」未指定所屬領域，未計入任何領域。合計列的可用格數來自「② 年級」節次表。</p>
  </div></div>`;

  return head + refCard + cmpCard;
}

/* ==========================================================================
   ⑤ 排課 + 課表輸出（新模型：格子放科目、老師由 teacher.load 推得）
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
function adjacentOpenPeriod(grade, periodId, day, dir) {
  const arr = state.settings.periods; const i = arr.findIndex(p => p.id === periodId);
  if (i < 0) return null; const nb = arr[i + dir];
  if (!nb || nb.isBreak || !gradePeriodHasDay(grade, nb.id, day)) return null;
  return nb.id;
}
function teacherScheduled(t) {
  return (t.load || []).reduce((sum, L) => {
    const s = subjectById(L.subjectId);
    return sum + ((s && s.splitTeachers) ? placedByTeacher(L.classId, L.subjectId, t.id) : subjectPlaced(L.classId, L.subjectId));
  }, 0);
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
  for (const key in state.slots) {
    const sid = state.slots[key]; const s = subjectById(sid); if (!s || !s.consecutive) continue;
    const [classId, dayStr, period] = key.split('|'); const day = parseInt(dayStr, 10);
    const g = classGrade(classById(classId)); if (!g) continue;
    const prev = adjacentOpenPeriod(g, period, day, -1), next = adjacentOpenPeriod(g, period, day, +1);
    const paired = (prev && state.slots[slotKey(classId, day, prev)] === sid) || (next && state.slots[slotKey(classId, day, next)] === sid);
    if (!paired) add(key, '連堂未相鄰');
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
          for (let i = 0; i < need; i++) units.push({ classId: c.id, sid, teacherId: L.teacher.id, consec: !!s.consecutive, loose });
        });
      } else {
        const need = sh.hours - subjectPlaced(c.id, sid);
        for (let i = 0; i < need; i++) units.push({ classId: c.id, sid, teacherId: null, consec: !!s.consecutive, loose });
      }
    });
  });
  // 緊度小的先排；同緊度連堂先排
  units.sort((a, b) => (a.loose - b.loose) || (b.consec - a.consec));
  return units;
}
// 單格軟性評分（越低越好）：偏好時段、同科分散不同天、教師每日平衡、上午避免湊滿
function cellSoftScore(classId, day, period, sid, teacherId) {
  const s = subjectById(sid); let sc = 0;
  if (s.preferBand === 'am' && !isMorningPeriod(period)) sc += 4;
  if (s.preferBand === 'pm' && isMorningPeriod(period)) sc += 4;
  if (!s.consecutive) { for (const key in state.slots) { if (state.slots[key] === sid) { const p = key.split('|'); if (p[0] === classId && parseInt(p[1], 10) === day) { sc += 3; break; } } } }
  const tids = s.splitTeachers ? [teacherId] : loadsForClassSubject(classId, sid).map(x => x.teacher.id);
  tids.forEach(tid => { if (tid) sc += teacherDayLoad(tid, day) * 0.5; });
  if (isMorningPeriod(period)) tids.forEach(tid => { if (!tid) return; let am = 0; for (const key in state.slots) { const p = key.split('|'); if (parseInt(p[1], 10) === day && isMorningPeriod(p[2])) slotAssignments(key).forEach(x => { if (x.teacherId === tid) am++; }); } if (am >= 3) sc += 2; });
  return sc;
}
// 整體方案軟性罰分（越低越好）：教師每日節數離散、上午滿堂、偏好時段、同科同日重複
function scoreSolution() {
  let pen = 0; const perTD = {};
  for (const key in state.slots) { const p = key.split('|'); const d = parseInt(p[1], 10); slotAssignments(key).forEach(x => { if (!x.teacherId) return; (perTD[x.teacherId] = perTD[x.teacherId] || {}); (perTD[x.teacherId][d] = perTD[x.teacherId][d] || new Set()).add(p[2]); }); }
  for (const tid in perTD) { const dd = perTD[tid]; const sizes = Object.values(dd).map(s => s.size); if (sizes.length) pen += Math.max(...sizes) - Math.min(...sizes);
    for (const d in dd) { let am = 0; dd[d].forEach(pid => { if (isMorningPeriod(pid)) am++; }); if (am >= 4) pen += 2; } }
  const seen = {};
  for (const key in state.slots) { const sid = state.slots[key]; const s = subjectById(sid); const p = key.split('|');
    if (s.preferBand === 'am' && !isMorningPeriod(p[2])) pen += 1;
    if (s.preferBand === 'pm' && isMorningPeriod(p[2])) pen += 1;
    if (!s.consecutive) { const k = p[0] + '|' + sid + '|' + p[1]; seen[k] = (seen[k] || 0) + 1; } }
  for (const k in seen) if (seen[k] > 1) pen += (seen[k] - 1);
  return pen;
}
// 一趟貪婪填課（靜態緊度序 + 軟分挑格 + 隨機抖動）；直接寫入 state.slots
function greedyRun(units, rnd) {
  const unplaced = []; let guard = 0;
  while (units.length && guard++ < 20000) {
    const u = units.shift();
    const cands = candidateCells(u.classId, u.sid, u.teacherId);
    if (!cands.length) { unplaced.push(u); continue; }
    let best = null, bestScore = Infinity, bestPartner = null;
    for (const cell of cands) {
      let sc = cellSoftScore(u.classId, cell.day, cell.period, u.sid, u.teacherId) + rnd() * 0.9;
      let partner = null;
      if (u.consec) { partner = adjacentLegalCell(u.classId, u.sid, u.teacherId, cell.day, cell.period); if (!partner) sc += 5; }
      if (sc < bestScore) { bestScore = sc; best = cell; bestPartner = partner; }
    }
    placeSubject(u.classId, String(best.day), best.period, u.sid, u.teacherId);
    if (u.consec && bestPartner) {
      placeSubject(u.classId, String(bestPartner.day), bestPartner.period, u.sid, u.teacherId);
      const j = units.findIndex(x => x.classId === u.classId && x.sid === u.sid && x.teacherId === u.teacherId);
      if (j >= 0) units.splice(j, 1);
    }
  }
  return unplaced;
}
// 隨機重啟求解：多趟貪婪，保留「排最多、其次罰分最低」的最佳解
function runAutoSchedule(clearFirst) {
  const baseSlots = clearFirst ? {} : { ...state.slots };
  const baseST = clearFirst ? {} : { ...state.slotTeachers };
  let seed = 20260804; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let best = null, runs = 0; const t0 = performance.now(); const BUDGET = 2500;
  do {
    state.slots = { ...baseSlots }; state.slotTeachers = { ...baseST };
    const units = buildAutoUnits();
    units.forEach(u => (u._r = rnd()));
    units.sort((a, b) => (a.loose - b.loose) || (b.consec - a.consec) || (a._r - b._r));
    const unplaced = greedyRun(units, rnd);
    const placed = Object.keys(state.slots).length; const penalty = scoreSolution();
    const key = placed * 100000 - penalty;
    if (!best || key > best.key) best = { key, slots: { ...state.slots }, slotTeachers: { ...state.slotTeachers }, unplaced, placed, penalty };
    runs++;
  } while (performance.now() - t0 < BUDGET && runs < 300);
  state.slots = best.slots; state.slotTeachers = best.slotTeachers; save();
  return { unplaced: best.unplaced, runs, ms: Math.round(performance.now() - t0), penalty: best.penalty };
}
function autoScheduleModal() {
  if (state.lockFinalized) { toast('課表已鎖定，請先解除鎖定再自動排課'); return; }
  const problems = checkStaffing();
  if (problems.length) { toast('尚有配課問題，請先在「④ 教師」把各班每科節數配齊'); return; }
  openModal({
    title: '🪄 自動排課（全校）',
    body: `<p style="margin-top:0">依科目的教學型態與排課限制、教師配課、不排課時段與教師單日上限，自動把各班每科排滿，並避開教師/教室衝堂。會多次嘗試取較佳解（教師每日節數較平均、偏好時段盡量滿足）。</p>
      <p style="color:var(--muted);font-size:13px">這是輔助工具：能排的先排滿，排不下的會列出讓你手動處理。排完仍可自由手動微調。</p>
      <label class="checkbox" style="margin-top:8px"><input type="checkbox" id="autoClear" checked> 清空現有排課，全部重排（取消則只補空格、保留已排）</label>`,
    saveLabel: '開始排課',
    onSave: () => {
      const clear = $('#autoClear').checked;
      const r = runAutoSchedule(clear);
      render();
      setTimeout(() => autoResultModal(r.unplaced, r), 0); // 等 modal-save 關掉設定 modal 後再開結果 modal
      return true;
    },
  });
}
function autoResultModal(unplaced, r) {
  const total = Object.keys(state.slots).length;
  const conf = Object.keys(computeConflicts()).length;
  let body = `<div class="total-badge ${unplaced.length ? 'bad' : 'ok'}">${unplaced.length ? `⚠ 有 ${unplaced.length} 節排不下（其餘已排）` : '✓ 全部排滿'}　·　已排 ${total} 格　·　衝堂 ${conf}</div>
    <p style="color:var(--muted);font-size:12px;margin:6px 0 0">嘗試 ${r.runs} 種排法取最佳（品質分 ${r.penalty}，越低越好）·　${r.ms}ms</p>`;
  if (unplaced.length) {
    const agg = {};
    unplaced.forEach(u => { const k = u.classId + '|' + u.sid + '|' + (u.teacherId || ''); agg[k] = agg[k] || { u, n: 0 }; agg[k].n++; });
    body += `<p style="color:var(--danger);font-weight:700;margin:12px 0 4px">排不下的課（無合法空格：可能受科目日/節限制、教師不排課、或衝堂擠壓）：</p>
      <table class="data"><thead><tr><th>班級</th><th>科目</th><th>老師</th><th>缺幾節</th></tr></thead><tbody>
      ${Object.values(agg).map(({ u, n }) => `<tr><td>${esc((classById(u.classId) || {}).name || '')}</td><td>${esc(subjectName(u.sid))}</td><td>${u.teacherId ? esc(teacherName(u.teacherId)) : '<span style="color:var(--muted)">—</span>'}</td><td style="font-weight:700">${n}</td></tr>`).join('')}
      </tbody></table>
      <p style="color:var(--muted);font-size:12px;margin-top:8px">建議：放寬該科的排課限制、調整教師不排課時段，或手動挪動相鄰課程騰出空間後，再按一次「只補空格」。</p>`;
  }
  openModal({ title: '自動排課結果', wide: true, body });
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
// 找調課連鎖：搬動班內「單純」課讓 (sid,teacher) 能排進 classId。回傳 {cell, moves:[{from,to,sid}]} 或 null。state-preserving。
function findEvictionChain(classId, sid, teacherId, maxDepth) {
  const savedSlots = { ...state.slots }, savedST = { ...state.slotTeachers };
  const budget = { n: 4000 };
  function dfs(curSid, curTeacher, depth, avoid) {
    if (budget.n-- <= 0) return null;
    for (const c of candidateCells(classId, curSid, curTeacher)) { const k = slotKey(classId, c.day, c.period); if (!avoid.has(k)) return { cell: k, moves: [] }; }
    if (depth <= 0) return null;
    for (const cell of openGridCells(classId)) {
      const k = slotKey(classId, cell.day, cell.period); if (avoid.has(k)) continue;
      const occSid = state.slots[k]; if (!occSid) continue;
      if (!isSimpleSubject(occSid, classId)) continue;
      delete state.slots[k]; const occT = state.slotTeachers[k]; if (occT) delete state.slotTeachers[k];
      let ret = null;
      if (canPlaceAt(classId, cell.day, cell.period, curSid, curTeacher)) {
        const nav = new Set(avoid); nav.add(k);
        const sub = dfs(occSid, null, depth - 1, nav);
        if (sub) ret = { cell: k, moves: [...sub.moves, { from: k, to: sub.cell, sid: occSid }] };
      }
      state.slots[k] = occSid; if (occT) state.slotTeachers[k] = occT;
      if (ret) return ret;
    }
    return null;
  }
  let result = null;
  try { result = dfs(sid, teacherId, maxDepth, new Set()); }
  finally { state.slots = savedSlots; state.slotTeachers = savedST; }
  return result;
}
// 放課共用邏輯（協同同步 + 連堂成對），回傳提示；供手動點格與建議放入共用
function placeWithExtras(classId, day, period, sid, tid) {
  const s = subjectById(sid); const dNum = parseInt(day, 10); const notes = [];
  const linked = placeSubject(classId, day, period, sid, tid);
  if (linked) notes.push(`協同同步 ${linked} 班`);
  if (s && s.consecutive && state.settings.autoPairConsecutive !== false && subjectPlaced(classId, sid) < classSubjectRequired(classId, sid)) {
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
    const req = selfCourseRequired(classId, s.id), pl = selfCoursePlaced(classId, s.id);
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
      : `<p style="color:var(--muted)">本班沒有級任導師、或導師在本班無配課，無可選科目。請到「④ 教師」設定本班導師與其配課。</p>`,
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
function swapSuggestModal(classId, sid, teacherId) {
  if (!isSimpleSubject(sid, classId)) { toast('此科為分組/協同/分節/連堂，暫不支援自動調課建議，請手動處理'); return; }
  const chain = findEvictionChain(classId, sid, teacherId, 3);
  const clsName = (classById(classId) || {}).name || '';
  if (!chain) { openModal({ title: '調課建議', body: `<p style="margin-top:0">找不到 3 步內的調課方式，讓「${esc(subjectName(sid))}」排進「${esc(clsName)}」。</p><p style="color:var(--muted)">建議：放寬該科的排課限制、調整教師不排課時段或單日上限，或先手動挪動更多課後再試。</p>` }); return; }
  const stepHtml = chain.moves.map((m, i) => { const a = m.from.split('|'), b = m.to.split('|');
    return `<li>把「<b>${esc(subjectName(m.sid))}</b>」從 ${DAY_LABELS[+a[1]]}${esc(periodLabel(a[2]))} → 移到 ${DAY_LABELS[+b[1]]}${esc(periodLabel(b[2]))}</li>`; }).join('');
  const t = chain.cell.split('|');
  const finalHtml = `<li>再把「<b>${esc(subjectName(sid))}</b>」放到 ${DAY_LABELS[+t[1]]}${esc(periodLabel(t[2]))}</li>`;
  const body = `<p style="margin-top:0">要讓「<b>${esc(subjectName(sid))}</b>」排進「${esc(clsName)}」，建議這樣調（${chain.moves.length ? chain.moves.length + ' 步移動' : '直接放入'}）：</p>
    <ol style="line-height:1.9">${stepHtml}${finalHtml}</ol>
    <p style="color:var(--muted);font-size:12px">套用後不會產生任何衝堂；若不滿意可手動移除再重排。</p>`;
  openModal({ title: '調課建議', wide: true, body, saveLabel: '套用建議', onSave: () => {
    chain.moves.forEach(m => { delete state.slots[m.from]; delete state.slotTeachers[m.from]; state.slots[m.to] = m.sid; });
    placeSubject(classId, t[1], t[2], sid, teacherId);
    save(); render(); toast('已套用調課建議');
    return true;
  } });
}

function viewSchedule() {
  if (state.classes.length === 0) return emptyState('尚未建立班級', '請先完成 ①科目 ②年級 ③班級 ④教師，再來排課。');
  if (!staffingConfirmed()) {
    const problems = checkStaffing();
    const noHr = unsetHomerooms();
    const detail = staffingClear()
      ? '資料已齊，但尚未在「④ 教師」按過「檢查全校配課」完成確認。'
      : `${problems.length ? `配課問題 ${problems.length} 項；` : ''}${noHr.length ? `未設導師班級 ${noHr.length} 個（${esc(noHr.join('、'))}）；` : ''}請修正後在「④ 教師」按「檢查全校配課」。`;
    return `<div class="page-head"><h2>⑤ 排課</h2></div>
    <div class="card"><div class="card-body">
      <div class="conflict-banner">⚠ 尚未通過全校檢查，無法開始排課。<div style="font-weight:400;margin-top:4px">${detail}</div></div>
      <button class="btn" data-action="goto-teachers">前往 ④ 教師 檢查全校配課</button>
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
      ? `<div class="lock-banner no-print"><span>🔒 課表已鎖定（${state.locked ? '一鍵全鎖' : '單格鎖定 ' + (state.lockedCells || []).length + ' 格'}）。自編格已釋放供導師選課${selfCellCount ? `；本班（${esc((classById(selCls) || {}).name || '')}）自編 ${selfDoneCls ? '已完成🔒' : selfCellCount + ' 格'}` : ''}；其餘鎖定格唯讀。</span>${selfBtn}<button class="btn" data-action="unlock-schedule">🔓 解除鎖定</button></div>`
      : '';
  const toolbarBtns = selecting ? '' : finalized ? '' :
    `<button class="ghost" data-action="lock-schedule" style="margin-left:auto" title="整表一次鎖定">🔒 一鍵鎖定</button><button class="ghost" data-action="lockcell-mode" title="逐格點選要鎖的格">🎯 單格鎖定</button><button class="btn" data-action="auto-schedule">🪄 自動排課</button>`;
  return `
    <div class="page-head no-print"><h2>⑤ 排課</h2><div class="hint">${hint}</div></div>
    ${banner}
    ${totalConf ? `<div class="conflict-banner no-print">⚠ 全校目前有 ${totalConf} 個需注意的格子（教師衝堂／不排課／協同未同步／連堂未相鄰）。</div>` : ''}
    <div class="board-toolbar no-print"><label>班級：</label><select id="scheduleClass" data-change="schedule-class">${classOpts}</select>
      <span style="margin-left:auto"></span>${toolbarBtns}</div>
    <div class="schedule-layout ${boardBusy ? 'locked' : ''}">
      ${boardBusy ? '' : `<div class="palette card no-print"><div class="card-body"><h4>科目調色盤</h4>${paletteHTML(selectedClassId)}</div></div>`}
      <div class="card"><div class="card-body">
        <div class="grid-wrap">${classTimetableHTML(selectedClassId, conflicts, true)}</div>
        <div class="teacher-load no-print">${teacherLoadHTML()}</div>
      </div></div>
    </div>`;
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
        chips.push(`<div class="chip" style="border-left-color:${s.color};opacity:.6"><div><div class="chip-name">✂️${esc(s.name)}</div><div class="chip-sub">尚未在「④教師」配課</div></div></div>`);
        return;
      }
      loads.forEach(L => {
        const tid = L.teacher.id; const placed = placedByTeacher(classId, sid, tid);
        const done = placed >= L.hours, over = placed > L.hours;
        const seld = sid === selectedSubjectId && tid === selectedTeacherId;
        const room = L.roomId ? ' · ' + esc(roomName(L.roomId)) : '';
        chips.push(`<div class="chip ${seld ? 'selected' : ''} ${done && !over ? 'done' : ''}" style="border-left-color:${s.color}" data-action="select-subject" data-id="${sid}" data-teacher="${tid}">
          <div><div class="chip-name">✂️${s.consecutive ? '⏱' : ''}${esc(s.name)}</div>
            <div class="chip-sub">${esc(L.teacher.name)}${room}</div></div>
          <span class="chip-count" style="color:${over ? 'var(--danger)' : done ? 'var(--ok)' : 'var(--muted)'}">${placed}/${L.hours}</span>
        </div>`);
      });
      return;
    }
    const placed = subjectPlaced(classId, sid); const done = placed >= sh.hours, over = placed > sh.hours;
    const partners = classCoteachPartners(c, sid);
    const seld = sid === selectedSubjectId && !selectedTeacherId;
    const stuck = !done && isSimpleSubject(sid, classId) && candidateCells(classId, sid, null).length === 0;
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
        const s = sid ? subjectById(sid) : null; const color = s ? s.color : '#10b981';
        const tlock = selfCellTeacherLocked(key);                   // v09.00 導師自編完成→唯讀
        const co = s ? classCoteachPartners(c, sid).length : 0;
        html += `<td class="cell ${editable ? 'placeable' : ''}" ${dataAct} title="${tlock ? '導師自編已鎖定（唯讀）' : '自編格（導師選課）'}">
          <div class="cell-lesson self-designed ${s ? '' : 'released'} ${tlock ? 'locked' : ''}" style="background:${color};color:${textOn(color)}">${tlock ? '🔒' : '🧩'}${co ? '🔗' : ''}${s ? esc(s.name) : '自編'}
            <small>${s ? esc(slotTeachersLabel(key)) : '＋ 點選課程'}</small></div></td>`;
      } else if (sid) {
        const s = subjectById(sid); const color = s ? s.color : '#94a3b8';
        const co = classCoteachPartners(c, sid).length;
        const selfBadge = selfPreview ? '<span class="lock-mark self" title="級任導師任課：完成鎖定後將自動釋放為導師自編">🧩</span>' : '';
        html += `<td class="cell ${editable ? 'placeable' : ''} ${canSelect ? 'lock-target' : ''} ${cellSel ? 'lock-sel' : ''} ${selfPreview ? 'self-preview' : ''}" ${dataAct} title="${selfPreview ? '級任導師任課→完成鎖定後自動釋放為導師自編（單格鎖定時不可鎖）' : (conf ? esc(conf.join('；')) : '')}">
          <div class="cell-lesson ${conf ? 'conflict' : ''} ${isLocked ? 'locked' : ''}" style="background:${color};color:${textOn(color)}">
            ${lockMark}${selMark}${selfBadge}${co ? '🔗' : ''}${s && s.allowGrouping ? '👥' : ''}${s && s.splitTeachers ? '✂️' : ''}${esc(subjectName(sid))}
            <small>${esc(slotTeachersLabel(key))}${!(s && s.splitTeachers) && roomsLabelCS(classId, sid) ? '·' + esc(roomsLabelCS(classId, sid)) : ''}</small>
            ${conf ? `<span class="conf-mark">⚠ ${conf.some(x => x.includes('衝堂') || x.includes('不排課')) ? '衝堂' : conf.some(x => x.startsWith('協同')) ? '協同未同步' : '連堂未相鄰'}</span>` : ''}
          </div></td>`;
      } else if (open) {
        html += `<td class="cell ${editable ? 'placeable' : ''} ${canSelect ? 'lock-target' : ''} ${cellSel ? 'lock-sel' : ''} ${isLocked ? 'blocked-lock' : ''}" ${dataAct}>${lockMark}${selMark}</td>`;
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
  if (state.classes.length === 0) return emptyState('尚無資料', '請先完成前面步驟並排課。');
  const conflicts = computeConflicts();
  if (outputMode === 'class') { if (!outputClassId || !classById(outputClassId)) outputClassId = state.classes[0].id; }
  else { if (state.teachers.length === 0) { outputMode = 'class'; outputClassId = state.classes[0].id; } else if (!outputTeacherId || !teacherById(outputTeacherId)) outputTeacherId = state.teachers[0].id; }
  const modeSel = `<div class="board-toolbar no-print">
      <label>類型：</label>
      <select id="outMode" data-change="out-mode"><option value="class" ${outputMode === 'class' ? 'selected' : ''}>班級課表</option><option value="teacher" ${outputMode === 'teacher' ? 'selected' : ''}>教師課表</option></select>
      ${outputMode === 'class'
      ? `<select id="outClass" data-change="out-class">${state.classes.map(c => `<option value="${c.id}" ${c.id === outputClassId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
      : `<select id="outTeacher" data-change="out-teacher">${state.teachers.map(t => `<option value="${t.id}" ${t.id === outputTeacherId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`}
      <button class="ghost" data-action="print-out">🖨️ 列印 / 存 PDF</button>
      <button class="ghost" data-action="csv-out">⬇️ 匯出 CSV</button>
      <span style="width:1px;height:20px;background:var(--line);margin:0 4px"></span>
      <button class="btn" data-action="all-class-docx">📄 所有班級課表(.docx)</button>
      <button class="btn" data-action="all-teacher-docx">📄 所有教師課表(.docx)</button></div>`;
  const grid = outputMode === 'class' ? classTimetableHTML(outputClassId, conflicts, false) : teacherTimetableHTML(outputTeacherId, conflicts);
  return `<div class="page-head no-print"><h2>課表輸出</h2></div>${modeSel}<div class="card"><div class="card-body"><div class="grid-wrap">${grid}</div></div></div>`;
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
        html += `<td class="cell"><div class="cell-lesson ${conf ? 'conflict' : ''}" style="background:${color};color:${textOn(color)}">${esc(label)}<small>${esc(subjectName(hits[0].sid))}</small></div></td>`;
      } else html += `<td class="cell"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
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
    <div class="page-head"><h2>設定</h2></div>
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
      ${state.rooms.length === 0 ? `<div style="color:var(--muted)">尚無專科教室（例：電腦教室、自然教室、音樂教室、體育館）。教室在「④ 教師配課」逐筆指定，排課會檢查同一教室同時段是否被兩班搶用。</div>`
      : `<table class="data"><tbody>${state.rooms.map(r => `<tr>
          <td><b>${esc(r.name)}</b></td>
          <td>${state.teachers.reduce((n, t) => n + (t.load || []).filter(L => L.roomId === r.id).length, 0)} 筆配課使用</td>
          <td class="row-actions"><button class="icon-btn" data-action="edit-room" data-id="${r.id}">✏️</button><button class="icon-btn" data-action="del-room" data-id="${r.id}">🗑️</button></td>
        </tr>`).join('')}</tbody></table>`}
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">排課選項</h4>
      <label class="checkbox"><input type="checkbox" data-change="toggle-autopair" ${state.settings.autoPairConsecutive !== false ? 'checked' : ''}> 需連堂排課時，自動成對放課（一組 2 節相鄰）</label>
      <label class="field" style="max-width:320px;margin-top:12px"><span>教師單日節數上限（自動排課用；0＝不限）</span>
        <input type="number" min="0" max="20" data-change="set-maxperday" value="${state.settings.maxLessonsPerDay || 0}"></label>
      <p class="hint" style="color:var(--muted);margin:6px 0 0">自動排課會避免任一教師單日超過此上限。個別教師可在「④ 教師」設不同上限；勾「不列入上限」的科目（如母語）不計。</p>
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">課表輸出格式（Word .docx）</h4>
      <p class="hint" style="color:var(--muted);margin:0 0 10px">「課表輸出」的📄一鍵輸出所有班級／教師課表會用到以下設定。</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <label class="field"><span>校名</span><input type="text" data-change="report-field" data-field="reportSchool" value="${esc(state.settings.reportSchool || '')}" style="min-width:260px"></label>
        <label class="field"><span>學年度</span><input type="text" data-change="report-field" data-field="reportYear" value="${esc(state.settings.reportYear || '')}" style="width:90px"></label>
      </div>
      <h5 style="margin:0 0 6px">科目顯示名稱對照（輸出用；留空＝用原名）</h5>
      <table class="data"><tbody>${state.subjects.map(s => {
        const eff = (state.settings.subjectMap && state.settings.subjectMap[s.name] != null) ? state.settings.subjectMap[s.name]
          : (typeof DocxGen !== 'undefined' && DocxGen.DEFAULT_MAP[s.name] != null ? DocxGen.DEFAULT_MAP[s.name] : s.name);
        return `<tr><td style="width:140px">${esc(s.name)}</td><td><input type="text" data-change="subjmap-field" data-subj="${esc(s.name)}" value="${esc(eff)}" style="width:200px"></td></tr>`;
      }).join('')}</tbody></table>
      <p class="hint" style="color:var(--muted);margin-top:8px">母語可用「/」分列（如 阿美語/閩南語）。固定版面（整潔活動、導師時間、午餐、午休、第八節、週三下午教學研究、學生人數欄）已比照範本內建。</p>
    </div></div>
    ${cloudSettingsCard()}
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
        state = data; if (!state.slotTeachers || typeof state.slotTeachers !== 'object') state.slotTeachers = {}; if (!state.slotContent || typeof state.slotContent !== 'object') state.slotContent = {}; if (!Array.isArray(state.lockedCells)) state.lockedCells = []; if (!Array.isArray(state.selfCells)) state.selfCells = []; if (!state.selfBackup || typeof state.selfBackup !== 'object') state.selfBackup = {}; if (!state.selfDone || typeof state.selfDone !== 'object') state.selfDone = {}; if (typeof state.staffingOkSig !== 'string') state.staffingOkSig = ''; save(); closeModal(); selectedGradeId = null; render(); toast('已匯入備份');
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
  openModal({
    title: '使用說明　·　' + APP_VERSION, wide: true, body: `<div class="help">
    <div class="help-note">📌 <b>三個重點：</b>①免安裝免登入，用瀏覽器開網址就能用。②資料只存<b>你這台裝置</b>，各自獨立。③換裝置或清瀏覽器前，先用右上「備份」匯出。</div>
    <h4>操作順序（有前後關係，請照號碼走）</h4>
    <p class="help-flow">①科目 ▸ ②年級 ▸ ③班級 ▸ ④教師 ▸ ⑤排課 ▸ 課表輸出</p>
    <h4>① 科目</h4>
    <ul><li>建立全校科目、選顏色，並可指定<b>所屬領域</b>（供「領域節數」頁對照，可留未分類）。</li>
      <li><b>教學型態</b>三選一：<b>單一教師</b>整科一位老師上；<b>👥 分組教學</b>（如英語）同班多師「同一節」平行分組上、不算衝堂；<b>✂️ 分節上課</b>多師分攤節數、各上「不同節」（如生活 6 節＝A 上 4＋B 上 2）。</li>
      <li>⏱ <b>需連堂</b>：勾了的科目排課時自動把兩節排在相鄰位置。</li>
      <li>🔒 <b>排課限制</b>（給自動排課用）：可勾「只排在某些上課日／某些節次」。例：母語只勾週四、彈性在地勾週五＋第1節、體育只勾第2/3/6/7節。不勾＝不限；手動排課不受此限。</li>
      <li><b>進階排課</b>：可設「每天最多1節（分散不同天）」「兩節不排相鄰兩天（隔天，如體育）」「偏好時段（上午/下午）」「不列入教師單日上限（如母語）」，供自動排課參考。教師單日節數上限在「設定」設全域、「④教師」可個別覆寫。</li></ul>
    <h4>② 年級（一~六年級各一張）</h4>
    <ul><li><b>2.1 節次表</b>：每個年級逐格勾「哪節×哪個上課日有課」（例：週三下午不上課就取消那幾格）。</li>
      <li><b>2.2 科目節數</b>：勾該年級開的科目、填一周節數。<b>科目節數總和＝節次表可用節數</b>時，年級才算完成（分頁顯示 ✓）。</li></ul>
    <h4>③ 班級</h4>
    <ul><li>新增班級並選年級；課程（科目＋節數）<b>自動沿用該年級</b>設定、不需重填。</li>
      <li>點「科目 / 協同」可為每一科勾選<b>協同教學</b>的同年級其他班（同時段一起上）。</li></ul>
    <h4>④ 教師</h4>
    <ul><li>填姓名、身分、<b>每周授課時數</b>、不排課時段。身分選<b>級任</b>時，可設定其<b>擔任導師的班級</b>。</li>
      <li><b>教師配課</b>：逐筆「班級 → 科目 → 節數 → 教室（可留空）」。該師配課合計<b>必須等於每周授課時數</b>才能儲存。專科教室先在「設定」建立。</li>
      <li>上方狀態卡＋「檢查全校配課」：確認<b>每班每科節數都被配齊</b>（分組每師各需足額；分節多師加總＝需求）。全部相符才可進入排課。</li>
      <li>✂️ <b>分節上課</b>科目：直接把節數拆給不同老師（如生活給 A 4 節、B 2 節），下拉會顯示各科<b>剩餘節數</b>、填的節數不超過剩餘。</li></ul>
    <h4>⑤ 排課</h4>
    <ul><li>選班級 → 左側點科目 → 點課表空格放課；點已排格移除。灰色格＝該班該節不上課。</li>
      <li>💡 <b>空格建議</b>：未選科目時直接點空格，會列出「這一格可以放哪些課」（合法、不衝堂），點一項即放入。</li>
      <li>🔧 <b>喬課（調課建議）</b>：某科排不下時，調色盤該科會出現「🔧 喬課」，按下會建議「把哪幾堂挪去哪，就能空出位置」（含多步連鎖），可一鍵套用、保證不產生衝堂。</li>
      <li>🪄 <b>自動排課</b>（選用）：右上按鈕一鍵把各班每科排滿，會遵守科目的排課限制、進階限制（分散不同天/隔天）、教師配課、不排課時段、教師單日上限、並避開所有衝堂；還會多次嘗試取較佳解（教師每日節數較平均、偏好時段盡量滿足）。可選「清空重排」或「只補空格（保留已排）」。排不下的課會列出讓你手動處理；排完仍可自由手動微調。</li>
      <li>✂️ <b>分節上課</b>科目：左側每位老師各一個色塊，先點「要放哪位老師」再點格，該格就記下由誰上（各上不同節）。</li>
      <li>分組科目自動多師同格；協同科目放一班自動同步其他班；連堂自動成對。</li>
      <li>🔴 紅框代表需注意：教師衝堂／教室衝堂／不排課時段／協同未同步／連堂未相鄰（移到格上看原因）。</li>
      <li>🔒 <b>鎖定課表（定稿）</b>：兩種——<b>🔒 一鍵鎖定</b>整表一次鎖；<b>🎯 單格鎖定</b>逐格點選要鎖的格再按「完成鎖定」（未鎖的格仍可調）。完成鎖定時，<b>系統自動判定「本班級任導師任課」的格為自編</b>（協同須全為同年級級任導師），這些格<b>釋放為空白</b>。導師點空格→從<b>本班導師的配課科目</b>選課自排（追蹤各科節數；<b>協同科會連動夥伴班同格</b>）。選完按 <b>✅ 導師自編完成</b> 鎖定本班自編（有空格或衝堂會拒絕；協同科一併鎖夥伴班該格，夥伴班仍須各自按完成）；要重選由排課者按 <b>🔓 解鎖導師自編</b>。整表「解除鎖定」時，自編格會<b>還原成鎖定前的原排課</b>。</li></ul>
    <h4>領域節數</h4>
    <ul><li><b>建議節數參考表</b>：各領域每年級每周建議節數，可自行改名稱／節數、新增或刪除領域。內建 108 課綱國小起始值，<b>請務必依課綱／貴校校對</b>。</li>
      <li><b>各年級實配對照</b>：把「② 年級」設定的科目節數依「① 科目」的所屬領域加總，和建議並排（實配 / 建議）；相符綠、不符紅底，方便檢查各領域節數是否到位。未指定領域的科目會列在「未分類」。</li></ul>
    <h4>課表輸出 / 備份</h4>
    <p>可輸出班級表、教師表，列印或存 PDF、匯出 CSV。右上「備份」可匯出/匯入 JSON（換裝置用）。</p>
    <h4>☁️ 雲端同步（設定頁）</h4>
    <ul><li>連結 Google 帳號後，排課資料會自動備份到<b>你自己的雲端硬碟</b>（App 專屬隱藏資料夾、無伺服器）。</li>
      <li><b>多裝置接續</b>：在另一台開啟 App 時，若雲端有較新的備份會詢問是否還原，筆電／桌機可接續同一份資料。</li>
      <li><b>還原版本</b>：可從「最新版本」或每日保留的<b>歷史版本（最多 7 份）</b>挑一個還原。可隨時「更換帳號」或「解除連結」。</li></ul>
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
    _tokResolve = resolve; _tokReject = reject;
    try { tokenClient.requestAccessToken({ prompt: promptMode }); }
    catch (e) { _tokResolve = _tokReject = null; reject(e); }
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
  if (cloudState.fileId) return cloudState.fileId;
  const f = await driveFindFile(CLOUD_FILE_NAME);
  if (f) { cloudState.fileId = f.id; saveCloudState(); return f.id; }
  return '';
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
  try { state = defaultState(); await idbSet(STATE_KEY, state); selectedGradeId = null; currentTab = 'subjects'; render(); }
  finally { suppressCloud = false; }
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
  if (!cloudState.enabled || cloudBusy) return;
  try {
    const fileId = await resolveMainFileId();
    if (!fileId) return;
    const meta = await driveGetMeta(fileId);
    const remoteUpdated = meta && meta.appProperties && meta.appProperties.updatedAt;
    if (!remoteUpdated || remoteUpdated === cloudState.lastSyncedAt) return;
    const status = await cloudRestore({ confirmFirst: true, confirmMsg: '雲端有較新的備份（可能來自其他裝置）。\n\n要用雲端資料還原到此裝置嗎？選「取消」則保留此裝置資料，之後的變更會覆蓋雲端。' });
    if (status === 'declined') await cloudBackupNow({});
  } catch {}
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

  'add-subject': () => subjectModal(null),
  'edit-subject': el => subjectModal(subjectById(el.dataset.id)),
  'del-subject': el => delSubject(el.dataset.id),

  'add-teacher': () => teacherModal(null),
  'edit-teacher': el => teacherModal(teacherById(el.dataset.id)),
  'del-teacher': el => delTeacher(el.dataset.id),
  'check-staffing': () => staffingReportModal(),
  'goto-teachers': () => { currentTab = 'teachers'; render(); },
  'toggle-avail': el => { el.classList.toggle('off'); el.textContent = el.classList.contains('off') ? '✕' : ''; },
  'add-load-row': () => { syncLoadFromDOM(); const cid = state.classes[0] ? state.classes[0].id : ''; const idx = modalLoad.length; modalLoad.push({ classId: cid, subjectId: firstAvailableSubject(cid, idx), hours: 0 }); refreshLoadEditor(); updateLoadSum(); },
  'del-load-row': el => { syncLoadFromDOM(); modalLoad.splice(parseInt(el.dataset.idx, 10), 1); refreshLoadEditor(); updateLoadSum(); },

  'add-domain': () => { state.domains.push({ id: uid(), name: '新領域', hours: [0, 0, 0, 0, 0, 0] }); save(); render(); },
  'del-domain': el => {
    const d = domainById(el.dataset.id); if (!d) return;
    const used = state.subjects.filter(s => s.domainId === d.id);
    confirmDelete(`刪除領域「${d.name}」？${used.length ? '（' + used.length + ' 個科目將變回未分類）' : ''}`, () => {
      state.subjects.forEach(s => { if (s.domainId === d.id) s.domainId = ''; });
      state.domains = state.domains.filter(x => x.id !== d.id);
    });
  },

  'add-class': () => classModal(null),
  'edit-class': el => classModal(classById(el.dataset.id)),
  'del-class': el => delClass(el.dataset.id),
  'class-detail': el => classDetailModal(classById(el.dataset.id)),

  'sel-grade': el => { selectedGradeId = el.dataset.id; render(); },
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
  'pick-selfcourse': el => {
    const key = el.dataset.key, sid = el.dataset.sid; const [classId, day, period] = key.split('|');
    if (selfCellTeacherLocked(key)) { toast('此格已鎖定'); return; }
    if (state.slots[key] !== sid && selfCoursePlaced(classId, sid) >= selfCourseRequired(classId, sid)) { toast('該科已達配課節數'); return; }
    state.slots[key] = sid;
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

  'print-out': () => window.print(),
  'csv-out': exportCSV,
  'all-class-docx': exportAllClassDocx,
  'all-teacher-docx': exportAllTeacherDocx,

  'export-json': exportJSON,
  'import-json': importJSON,

  'cloud-connect': () => cloudConnect(),
  'cloud-backup': () => cloudBackupNow({ manual: true, interactive: true }),
  'cloud-restore': () => openRestorePicker(),
  'cloud-switch': () => cloudSwitchAccount(),
  'cloud-disconnect': () => cloudDisconnect(),
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
  'toggle-autopair': el => { state.settings.autoPairConsecutive = el.checked; save(); },
  'set-maxperday': el => { state.settings.maxLessonsPerDay = parseInt(el.value, 10) || 0; save(); },
  'report-field': el => { state.settings[el.dataset.field] = el.value; save(); },
  'subjmap-field': el => { if (!state.settings.subjectMap) state.settings.subjectMap = {}; const v = el.value.trim(); if (v === '') delete state.settings.subjectMap[el.dataset.subj]; else state.settings.subjectMap[el.dataset.subj] = v; save(); },
  'domain-name': el => { const d = domainById(el.dataset.id); if (d) { d.name = el.value; save(); render(); } },
  'domain-hours': el => {
    const d = domainById(el.dataset.id); if (!d) return;
    if (!Array.isArray(d.hours)) d.hours = [0, 0, 0, 0, 0, 0];
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
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; currentTab = b.dataset.tab; render(); });
  $('#backupBtn').addEventListener('click', backupMenu);
  const help = $('#helpBtn'); if (help) help.addEventListener('click', helpModal);
  document.addEventListener('click', e => { const el = e.target.closest('[data-action]'); if (!el) return; const fn = clickHandlers[el.dataset.action]; if (fn) fn(el, e); });
  document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (!el) return; const fn = changeHandlers[el.dataset.change]; if (fn) fn(el, e); });
  $('#versionTag').textContent = APP_VERSION;
}

function upgradeNoticeModal() {
  openModal({ title: '系統改版通知', body: `<div class="help-note" style="margin:0">課務編排系統全面改版，先前的設定內容無法相容，改版後所有資料將會清除。已開啟使用過的同仁，請重新整理網頁，重新開始建置。</div>` });
}

/* ---------- Init ---------- */
async function init() {
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
  state.subjects.forEach(s => { if (s.selfDesigned) delete s.selfDesigned; });                // v08.03 移除舊手動自編旗標
  // v03.00 課表輸出格式欄位 guard（舊資料補預設）
  if (!state.settings.reportSchool) state.settings.reportSchool = '臺東縣成功鎮三民國民小學';
  if (!state.settings.reportYear) state.settings.reportYear = '113';
  if (!state.settings.subjectMap || typeof state.settings.subjectMap !== 'object') state.settings.subjectMap = {};
  if (!Array.isArray(state.domains)) state.domains = defaultDomains();                 // v06.00 領域節數參考表
  bindGlobal();
  render();
  if (hadOldData) upgradeNoticeModal();                                   // 舊版同仁：改版通知
  else if (!state.helpSeen) { helpModal(); state.helpSeen = true; save(); } // 新同仁：使用說明
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // v07.00 雲端同步：開 App 若雲端較新則詢問還原；回前景再檢查一次
  if (cloudState.enabled && cloudConfigured()) { cloudCheckOnOpen(); refreshCloudEmailIfMissing(); }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cloudState.enabled && cloudConfigured()) cloudCheckOnOpen();
  });
}
init();
