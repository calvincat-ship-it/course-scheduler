'use strict';

/* ==========================================================================
   課務編排 — 國小教學組長排課工具 (單人 / 純前端 PWA)
   資料層：IndexedDB 單一 state 文件（in-memory + 整包持久化）
   ========================================================================== */

const APP_VERSION = 'v01.05';
const DB_NAME = 'course_scheduler';
const STATE_KEY = 'state';

const DAY_LABELS = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const TEACHER_TYPES = ['級任', '科任', '兼行政'];
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#06b6d4', '#e11d48'];

/* ---------- IndexedDB kv ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- State ---------- */
let state = null;

function defaultState() {
  return {
    version: APP_VERSION,
    settings: {
      days: [1, 2, 3, 4, 5],
      periods: [
        { id: 'p1', label: '第1節', start: '08:40', end: '09:20', days: [1, 2, 3, 4, 5] },
        { id: 'p2', label: '第2節', start: '09:30', end: '10:10', days: [1, 2, 3, 4, 5] },
        { id: 'p3', label: '第3節', start: '10:30', end: '11:10', days: [1, 2, 3, 4, 5] },
        { id: 'p4', label: '第4節', start: '11:20', end: '12:00', days: [1, 2, 3, 4, 5] },
        { id: 'lunch', label: '午休', start: '12:00', end: '13:20', days: [] },
        { id: 'p5', label: '第5節', start: '13:30', end: '14:10', days: [1, 2, 3, 4, 5] },
        { id: 'p6', label: '第6節', start: '14:20', end: '15:00', days: [1, 2, 3, 4, 5] },
        { id: 'p7', label: '第7節', start: '15:20', end: '16:00', days: [1, 2, 3, 4, 5] },
      ],
      autoPairConsecutive: true, // 需連堂的課，放課時自動成對排入相鄰節
    },
    classes: [],
    teachers: [],
    subjects: [],
    rooms: [],
    assignments: [],
    slots: {}, // `${classId}|${day}|${period}` -> assignmentId
    helpSeen: false,
  };
}

function migrate(s) {
  s.settings = s.settings || {};
  s.settings.days = s.settings.days || [1, 2, 3, 4, 5];
  if (typeof s.settings.autoPairConsecutive !== 'boolean') s.settings.autoPairConsecutive = true; // v01.04
  s.settings.periods = s.settings.periods || defaultState().settings.periods;
  // v01.02: 節次由整週 lesson 布林 → 每日 days 陣列
  for (const p of s.settings.periods) {
    if (!Array.isArray(p.days)) {
      p.days = p.lesson === false ? [] : (s.settings.days || [1, 2, 3, 4, 5]).slice();
    }
    delete p.lesson;
  }
  for (const k of ['classes', 'teachers', 'subjects', 'rooms', 'assignments']) s[k] = s[k] || [];
  s.assignments.forEach(a => { if (typeof a.coteach !== 'string') a.coteach = ''; }); // v01.03 協同教學
  s.assignments.forEach(a => { // v01.05 分組教學：teacherId/roomId → groups[]
    if (!Array.isArray(a.groups)) a.groups = [{ teacherId: a.teacherId || '', roomId: a.roomId || '', label: '' }];
    delete a.teacherId; delete a.roomId;
  });
  s.slots = s.slots || {};
  if (typeof s.helpSeen !== 'boolean') s.helpSeen = false;
  s.version = APP_VERSION;
  return s;
}

async function save() { await idbSet(STATE_KEY, state); }

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const byId = (arr, id) => arr.find(x => x.id === id);
const classById = id => byId(state.classes, id);
const teacherById = id => byId(state.teachers, id);
const subjectById = id => byId(state.subjects, id);
const roomById = id => byId(state.rooms, id);
const assignmentById = id => byId(state.assignments, id);
const teacherName = id => (teacherById(id) || {}).name || '?';
const subjectName = id => (subjectById(id) || {}).name || '?';
const roomName = id => (roomById(id) || {}).name || '';
const slotKey = (c, d, p) => `${c}|${d}|${p}`;
const periodHasDay = (p, d) => (p.days || []).includes(d);
const isLessonPeriod = (p) => (p.days || []).some(d => state.settings.days.includes(d));
const lessonPeriods = () => state.settings.periods.filter(isLessonPeriod);
const activeDays = () => state.settings.days.slice().sort((a, b) => a - b);

function textOn(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1e293b' : '#ffffff';
}
function subjectColor(id) { const s = subjectById(id); return (s && s.color) || '#64748b'; }

function placedCount(assignmentId) {
  let n = 0;
  for (const k in state.slots) if (state.slots[k] === assignmentId) n++;
  return n;
}
function teacherLoad(teacherId) {
  let n = 0;
  for (const k in state.slots) {
    const a = assignmentById(state.slots[k]);
    if (a && assignmentUsesTeacher(a, teacherId)) n++;
  }
  return n;
}
function assignmentsForClass(classId) {
  return state.assignments.filter(a => a.classId === classId);
}
function refCount(pred) { return state.assignments.filter(pred).length; }

/* 分組教學：一筆配課可含多組，各組自己的老師/教室。groups: [{teacherId, roomId, label}]
   一般課＝1 組；分組教學＝2 組以上（同一時段拆組、不同老師）。 */
const assignmentGroups = a => (Array.isArray(a.groups) && a.groups.length ? a.groups : [{ teacherId: a.teacherId || '', roomId: a.roomId || '', label: '' }]);
const isGrouped = a => assignmentGroups(a).length > 1;
const teachersLabel = a => assignmentGroups(a).map(g => teacherName(g.teacherId) + (g.label ? `(${g.label})` : '')).join('｜');
function roomsLabel(a) {
  const rs = assignmentGroups(a).map(g => (g.roomId ? roomName(g.roomId) : '')).filter(Boolean);
  return rs.length ? [...new Set(rs)].join('｜') : '';
}
const assignmentUsesTeacher = (a, tid) => assignmentGroups(a).some(g => g.teacherId === tid);
const assignmentUsesRoom = (a, rid) => assignmentGroups(a).some(g => g.roomId === rid);

/* 協同教學：同一 coteach 群組的配課須排在同一時段 */
const coteachMembers = gid => (gid ? state.assignments.filter(a => a.coteach === gid) : []);
function cleanupCoteachSingletons() {
  const count = {};
  state.assignments.forEach(a => { if (a.coteach) count[a.coteach] = (count[a.coteach] || 0) + 1; });
  state.assignments.forEach(a => { if (a.coteach && count[a.coteach] < 2) a.coteach = ''; });
}
/* 連堂：相鄰節次判定（不跨午休/下課、不跨本日未上課的節） */
function adjacentLessonPeriod(periodId, day, dir) {
  const arr = state.settings.periods;
  const i = arr.findIndex(p => p.id === periodId);
  if (i < 0) return null;
  const nb = arr[i + dir];
  if (!nb || !periodHasDay(nb, day)) return null;
  return nb.id;
}
/* 放一筆課到某格，並把協同同群組其他班一併放入同一格（僅填空格）。回傳協同新增班數。 */
function placeAssignment(a, day, period) {
  const key = slotKey(a.classId, day, period);
  if (!state.slots[key]) state.slots[key] = a.id;
  let linked = 0;
  if (a.coteach) coteachMembers(a.coteach).forEach(m => {
    if (m.id === a.id) return;
    const mk = slotKey(m.classId, day, period);
    if (!state.slots[mk]) { state.slots[mk] = m.id; linked++; }
  });
  return linked;
}

function applyCoteach(meId, memberIds) {
  const me = assignmentById(meId);
  if (!me) return;
  const oldGroup = me.coteach || '';
  const full = [meId, ...memberIds.filter(id => id !== meId)];
  if (full.length <= 1) {
    me.coteach = '';
  } else {
    const groupId = oldGroup || uid();
    full.forEach(id => { const a = assignmentById(id); if (a) a.coteach = groupId; });
    if (oldGroup) state.assignments.forEach(a => { if (a.coteach === oldGroup && !full.includes(a.id)) a.coteach = ''; });
  }
  cleanupCoteachSingletons();
}

/* ---------- Conflict engine ---------- */
function computeConflicts() {
  const conflicts = {}; // slotKey -> [reason]
  const add = (key, reason) => { (conflicts[key] = conflicts[key] || []); if (!conflicts[key].includes(reason)) conflicts[key].push(reason); };
  const byDP = {};
  for (const key in state.slots) {
    const a = assignmentById(state.slots[key]);
    if (!a) continue;
    const [classId, day, period] = key.split('|');
    const dp = day + '|' + period;
    // 每一分組都是一個「授課實例」（各自老師/教室）
    assignmentGroups(a).forEach(g => (byDP[dp] = byDP[dp] || []).push({ key, classId, a, teacherId: g.teacherId, roomId: g.roomId }));
  }
  for (const dp in byDP) {
    const list = byDP[dp];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        // 同一協同群組彼此共用教師/教室是刻意的，不算衝堂
        const sameGroup = A.a.coteach && A.a.coteach === B.a.coteach;
        if (sameGroup) continue;
        if (A.teacherId && A.teacherId === B.teacherId) {
          const msg = '教師衝堂：' + teacherName(A.teacherId);
          add(A.key, msg); add(B.key, msg);
        }
        if (A.roomId && A.roomId === B.roomId) {
          const msg = '教室衝堂：' + roomName(A.roomId);
          add(A.key, msg); add(B.key, msg);
        }
      }
    }
  }
  // 協同未同步：同群組其他班沒排在同一格
  for (const key in state.slots) {
    const a = assignmentById(state.slots[key]);
    if (!a || !a.coteach) continue;
    const [, day, period] = key.split('|');
    for (const m of coteachMembers(a.coteach)) {
      if (m.id === a.id) continue;
      if (state.slots[slotKey(m.classId, day, period)] !== m.id) {
        add(key, '協同未同步：' + ((classById(m.classId) || {}).name || '') + ' 同節未排');
        break;
      }
    }
  }
  // 連堂未相鄰：標記需連堂的課，若同日相鄰節沒有同一門課接續
  for (const key in state.slots) {
    const a = assignmentById(state.slots[key]);
    if (!a || !a.consecutive || a.periods < 2) continue;
    const [classId, dayStr, period] = key.split('|');
    const day = parseInt(dayStr, 10);
    const prev = adjacentLessonPeriod(period, day, -1);
    const next = adjacentLessonPeriod(period, day, +1);
    const paired =
      (prev && state.slots[slotKey(classId, day, prev)] === a.id) ||
      (next && state.slots[slotKey(classId, day, next)] === a.id);
    if (!paired) add(key, '連堂未相鄰');
  }
  // teacher unavailable（逐組檢查）
  for (const key in state.slots) {
    const a = assignmentById(state.slots[key]);
    if (!a) continue;
    const [, day, period] = key.split('|');
    assignmentGroups(a).forEach(g => {
      const t = teacherById(g.teacherId);
      if (t && (t.unavailable || []).includes(day + '|' + period)) add(key, '教師不排課時段：' + t.name);
    });
  }
  return conflicts;
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

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
  const firstInput = $('#modalRoot input, #modalRoot select, #modalRoot textarea');
  if (firstInput) firstInput.focus();
}
function closeModal() { $('#modalRoot').innerHTML = ''; modalOnSave = null; }

/* ==========================================================================
   Router / render
   ========================================================================== */
let currentTab = 'schedule';
let selectedClassId = null;
let selectedAssignmentId = null;
let outputMode = 'class';
let outputClassId = null;
let outputTeacherId = null;

function render() {
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === currentTab));
  const view = $('#view');
  switch (currentTab) {
    case 'schedule': view.innerHTML = viewSchedule(); wireSchedule(); break;
    case 'assignments': view.innerHTML = viewAssignments(); break;
    case 'classes': view.innerHTML = viewClasses(); break;
    case 'teachers': view.innerHTML = viewTeachers(); break;
    case 'subjects': view.innerHTML = viewSubjects(); break;
    case 'rooms': view.innerHTML = viewRooms(); break;
    case 'output': view.innerHTML = viewOutput(); break;
    case 'settings': view.innerHTML = viewSettings(); break;
  }
}

/* ==========================================================================
   View: 排課 (核心)
   ========================================================================== */
function viewSchedule() {
  if (state.classes.length === 0)
    return emptyState('尚未建立班級', '請先到「班級」新增班級，再到「配課」建立課程。');
  if (state.assignments.length === 0)
    return emptyState('尚未建立配課', '請先到「配課」把「班級–科目–教師–節數」建好，才能開始排課。');

  if (!selectedClassId || !classById(selectedClassId)) selectedClassId = state.classes[0].id;
  const conflicts = computeConflicts();
  const totalConflictCells = Object.keys(conflicts).length;

  const classOpts = state.classes.map(c =>
    `<option value="${c.id}" ${c.id === selectedClassId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

  return `
    <div class="page-head no-print">
      <h2>排課</h2>
      <div class="hint">在左側點一個配課，再點課表空格放課；點已排的格子可移除。</div>
    </div>
    ${totalConflictCells ? `<div class="conflict-banner no-print">⚠ 全校目前有 ${totalConflictCells} 個需注意的格子（衝堂／協同未同步／連堂未相鄰），請檢查標記。</div>` : ''}
    <div class="board-toolbar no-print">
      <label>班級：</label>
      <select id="scheduleClass" data-change="schedule-class">${classOpts}</select>
    </div>
    <div class="schedule-layout">
      <div class="palette card no-print"><div class="card-body">
        <h4>配課調色盤</h4>
        ${paletteHTML(selectedClassId)}
      </div></div>
      <div class="card"><div class="card-body">
        <div class="grid-wrap">${timetableHTML(selectedClassId, conflicts, true)}</div>
        <div class="teacher-load no-print">${teacherLoadHTML()}</div>
      </div></div>
    </div>`;
}

function paletteHTML(classId) {
  const list = assignmentsForClass(classId);
  if (list.length === 0) return `<div class="empty">此班尚無配課</div>`;
  return list.map(a => {
    const placed = placedCount(a.id);
    const done = placed >= a.periods;
    const over = placed > a.periods;
    const color = subjectColor(a.subjectId);
    const cnt = `<span class="chip-count" style="color:${over ? 'var(--danger)' : done ? 'var(--ok)' : 'var(--muted)'}">${placed}/${a.periods}</span>`;
    return `<div class="chip ${a.id === selectedAssignmentId ? 'selected' : ''} ${done && !over ? 'done' : ''}"
        style="border-left-color:${color}" data-action="select-assignment" data-id="${a.id}">
        <div>
          <div class="chip-name">${esc(subjectName(a.subjectId))}</div>
          <div class="chip-sub">${isGrouped(a) ? '👥' : ''}${esc(teachersLabel(a))}${roomsLabel(a) ? ' · ' + esc(roomsLabel(a)) : ''}${a.consecutive ? ' · 連堂' : ''}${a.coteach ? ' · 🔗協同' : ''}</div>
        </div>
        ${cnt}
      </div>`;
  }).join('');
}

function timetableHTML(classId, conflicts, editable) {
  const days = activeDays();
  const cls = classById(classId);
  let html = `<table class="timetable">
    <thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead>
    <tbody>`;
  for (const p of state.settings.periods) {
    if (!isLessonPeriod(p)) {
      html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}　${esc(p.start)}–${esc(p.end)}</td></tr>`;
      continue;
    }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const key = slotKey(classId, d, p.id);
      const aId = state.slots[key];
      const a = aId ? assignmentById(aId) : null;
      const conf = conflicts[key];
      const open = periodHasDay(p, d); // 該節該日是否上課
      if (a) {
        const color = subjectColor(a.subjectId);
        html += `<td class="cell ${editable ? 'placeable' : ''}" ${editable ? `data-action="cell-click" data-key="${key}"` : ''}
          title="${conf ? esc(conf.join('；')) : ''}">
          <div class="cell-lesson ${conf ? 'conflict' : ''}" style="background:${color};color:${textOn(color)}">
            ${a.coteach ? '🔗' : ''}${isGrouped(a) ? '👥' : ''}${esc(subjectName(a.subjectId))}
            <small>${esc(teachersLabel(a))}${roomsLabel(a) ? '·' + esc(roomsLabel(a)) : ''}</small>
            ${conf ? `<span class="conf-mark">⚠ ${conf.some(c => c.includes('衝堂')) ? '衝堂' : conf.some(c => c.startsWith('協同')) ? '協同未同步' : '連堂未相鄰'}</span>` : ''}
          </div></td>`;
      } else if (open) {
        html += `<td class="cell ${editable ? 'placeable' : ''}" ${editable ? `data-action="cell-click" data-key="${key}"` : ''}></td>`;
      } else {
        html += `<td class="cell blocked" title="此節本日不上課"></td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  const head = cls ? `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc(cls.name)} 課表</div>` : '';
  return head + html;
}

function teacherLoadHTML() {
  if (state.teachers.length === 0) return '';
  const rows = state.teachers.map(t => {
    const load = teacherLoad(t.id);
    const max = t.maxPeriods || 0;
    const over = max > 0 && load > max;
    const pct = max > 0 ? Math.min(100, (load / max) * 100) : 0;
    return `<tr>
      <td>${esc(t.name)} <span class="pill gray">${esc(t.type || '')}</span></td>
      <td style="width:220px"><div class="load-bar ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div></td>
      <td style="white-space:nowrap;color:${over ? 'var(--danger)' : 'var(--muted)'};font-weight:700">${load}${max ? ' / ' + max : ''} 節${over ? ' 超支' : ''}</td>
    </tr>`;
  }).join('');
  return `<h4 style="margin:14px 0 8px">教師節數負荷</h4>
    <table class="data"><tbody>${rows}</tbody></table>`;
}

function wireSchedule() { /* interactions handled via delegation */ }

/* ==========================================================================
   View: 配課
   ========================================================================== */
function viewAssignments() {
  const head = `<div class="page-head"><h2>配課</h2>
    <button class="btn" data-action="add-assignment">＋ 新增配課</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">配課＝一門要上的課：班級 × 科目 × 授課教師 × 每週節數，是排課的輸入單位。</div>`;
  if (state.assignments.length === 0)
    return head + emptyCard('尚無配課', '需要先有班級、科目、教師，再新增配課。');
  const rows = state.assignments.slice().sort((a, b) => {
    const ca = (classById(a.classId) || {}).name || '', cb = (classById(b.classId) || {}).name || '';
    return ca.localeCompare(cb, 'zh-Hant');
  }).map(a => {
    const placed = placedCount(a.id);
    const status = placed >= a.periods
      ? `<span class="pill green">${placed}/${a.periods} 已排滿</span>`
      : `<span class="pill amber">${placed}/${a.periods}</span>`;
    return `<tr>
      <td>${esc((classById(a.classId) || {}).name || '?')}</td>
      <td><span class="pill" style="background:${subjectColor(a.subjectId)};color:${textOn(subjectColor(a.subjectId))}">${esc(subjectName(a.subjectId))}</span>${isGrouped(a) ? ` <span class="pill amber" title="分組教學：${esc(assignmentGroups(a).length)} 組不同老師">👥分組</span>` : ''}${a.coteach ? ` <span class="pill blue" title="協同教學：${esc(coteachMembers(a.coteach).filter(m => m.id !== a.id).map(m => (classById(m.classId) || {}).name).join('、'))}">🔗協同</span>` : ''}</td>
      <td>${esc(teachersLabel(a))}</td>
      <td>${a.periods}</td>
      <td>${roomsLabel(a) ? esc(roomsLabel(a)) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${a.consecutive ? '是' : '—'}</td>
      <td>${status}</td>
      <td class="row-actions">
        <button class="icon-btn" data-action="edit-assignment" data-id="${a.id}">✏️</button>
        <button class="icon-btn" data-action="del-assignment" data-id="${a.id}">🗑️</button>
      </td></tr>`;
  }).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>班級</th><th>科目</th><th>教師</th><th>每週節數</th><th>專科教室</th><th>連堂</th><th>已排</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function coteachPickerHTML(subjectId, meId, groupId) {
  const cands = state.assignments.filter(a => a.id !== meId && a.subjectId === subjectId);
  if (cands.length === 0)
    return `<div class="hint" style="color:var(--muted)">目前沒有其他班的同科目配課可協同。先建立另一班的同科目配課，再回來勾選即可。</div>`;
  return cands.map(a => {
    const checked = groupId && a.coteach === groupId;
    const otherGroup = a.coteach && a.coteach !== groupId;
    return `<label class="checkbox" style="margin-bottom:6px;font-weight:400">
      <input type="checkbox" data-coteach data-id="${a.id}" ${checked ? 'checked' : ''}>
      ${esc((classById(a.classId) || {}).name || '')} · ${esc(teachersLabel(a))}（${a.periods}節）${otherGroup ? ' <span class="pill amber">已在其他協同組</span>' : ''}
    </label>`;
  }).join('');
}

let modalGroups = []; // 配課 modal 編輯中的分組 [{teacherId, roomId, label}]
function groupsEditorHTML() {
  const multi = modalGroups.length > 1;
  const tOpts = sel => state.teachers.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}（${esc(x.type || '')}）</option>`).join('');
  const rOpts = sel => `<option value="">— 無教室 —</option>` + state.rooms.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const rows = modalGroups.map((g, i) => `
    <div class="group-row" data-idx="${i}">
      ${multi ? `<input type="text" class="grp-label" placeholder="組名" value="${esc(g.label || '')}" style="width:70px">` : ''}
      <select class="grp-teacher">${tOpts(g.teacherId)}</select>
      <select class="grp-room">${rOpts(g.roomId)}</select>
      ${multi ? `<button type="button" class="icon-btn" data-action="del-group-row" data-idx="${i}">🗑️</button>` : ''}
    </div>`).join('');
  return rows + `<button type="button" class="ghost" data-action="add-group-row" style="margin-top:6px;padding:5px 10px;font-size:13px">＋ 新增分組（不同老師同時上）</button>`;
}
function syncGroupsFromDOM() {
  const rows = Array.from(document.querySelectorAll('#groupsEditor .group-row'));
  if (rows.length) modalGroups = rows.map(r => ({
    teacherId: r.querySelector('.grp-teacher').value,
    roomId: r.querySelector('.grp-room').value,
    label: (r.querySelector('.grp-label') ? r.querySelector('.grp-label').value.trim() : ''),
  }));
}
function refreshGroupsEditor() { const el = $('#groupsEditor'); if (el) el.innerHTML = groupsEditorHTML(); }

function assignmentModal(existing) {
  if (state.classes.length === 0 || state.subjects.length === 0 || state.teachers.length === 0) {
    openModal({ title: '無法新增配課', body: `<p>請先建立至少一個<b>班級</b>、<b>科目</b>與<b>教師</b>。</p>` });
    return;
  }
  const a = existing || { classId: state.classes[0].id, subjectId: state.subjects[0].id, periods: 1, consecutive: false };
  const meId = existing ? existing.id : '';
  const groupId = existing ? (existing.coteach || '') : '';
  modalGroups = existing ? assignmentGroups(existing).map(g => ({ teacherId: g.teacherId, roomId: g.roomId || '', label: g.label || '' }))
    : [{ teacherId: state.teachers[0].id, roomId: '', label: '' }];
  const opt = (arr, sel, label) => arr.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
  openModal({
    title: existing ? '編輯配課' : '新增配課',
    body: `
      <div class="field-row">
        <label class="field"><span>班級</span><select id="aClass">${opt(state.classes, a.classId, x => x.name)}</select></label>
        <label class="field"><span>科目</span><select id="aSubject">${opt(state.subjects, a.subjectId, x => x.name)}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>每週節數</span><input type="number" id="aPeriods" min="1" max="40" value="${a.periods}"></label>
        <label class="field" style="display:flex;align-items:flex-end"><label class="checkbox"><input type="checkbox" id="aConsec" ${a.consecutive ? 'checked' : ''}> 需連堂</label></label>
      </div>
      <label class="field" style="margin-bottom:4px"><span>👥 授課教師 / 分組（每列一位老師＋教室；<b>加到 2 列以上＝分組教學</b>，同一時段拆組不同老師）</span></label>
      <div id="groupsEditor">${groupsEditorHTML()}</div>
      <label class="field" style="margin:14px 0 4px"><span>🔗 協同教學（勾選要與此課「同時段一起上」的其他班同科目配課）</span></label>
      <div id="coteachPicker">${coteachPickerHTML(a.subjectId, meId, groupId)}</div>`,
    onSave: () => {
      const periods = parseInt($('#aPeriods').value, 10);
      if (!periods || periods < 1) { toast('請輸入每週節數'); return false; }
      syncGroupsFromDOM();
      const groups = modalGroups.filter(g => g.teacherId);
      if (groups.length === 0) { toast('請至少指定一位授課教師'); return false; }
      const data = { classId: $('#aClass').value, subjectId: $('#aSubject').value, periods, consecutive: $('#aConsec').checked, groups };
      let id;
      if (existing) { Object.assign(existing, data); id = existing.id; }
      else { id = uid(); state.assignments.push({ id, ...data, coteach: '' }); }
      const members = Array.from(document.querySelectorAll('#coteachPicker input[data-coteach]:checked')).map(el => el.dataset.id);
      applyCoteach(id, members);
      save(); render(); toast('已儲存配課');
      return true;
    },
  });
  const subSel = $('#aSubject');
  if (subSel) subSel.addEventListener('change', () => {
    const picker = $('#coteachPicker');
    if (picker) picker.innerHTML = coteachPickerHTML(subSel.value, meId, groupId);
  });
}

/* ==========================================================================
   Views: 主檔 CRUD (班級 / 教師 / 科目 / 教室)
   ========================================================================== */
function viewClasses() {
  const head = `<div class="page-head"><h2>班級</h2><button class="btn" data-action="add-class">＋ 新增班級</button></div>`;
  if (state.classes.length === 0) return head + emptyCard('尚無班級', '例如：一年甲班、五年乙班。');
  const rows = state.classes.map(c => `<tr>
    <td><b>${esc(c.name)}</b></td><td>${esc(c.grade || '')}</td>
    <td>${assignmentsForClass(c.id).length} 筆配課</td>
    <td class="row-actions">
      <button class="icon-btn" data-action="edit-class" data-id="${c.id}">✏️</button>
      <button class="icon-btn" data-action="del-class" data-id="${c.id}">🗑️</button>
    </td></tr>`).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>班級</th><th>年級</th><th>配課</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function classModal(existing) {
  const c = existing || { name: '', grade: '' };
  const gradeOpts = ['一年級', '二年級', '三年級', '四年級', '五年級', '六年級']
    .map(g => `<option ${g === c.grade ? 'selected' : ''}>${g}</option>`).join('');
  openModal({
    title: existing ? '編輯班級' : '新增班級',
    body: `<label class="field"><span>班級名稱</span><input type="text" id="cName" value="${esc(c.name)}" placeholder="例：五年甲班"></label>
      <label class="field"><span>年級</span><select id="cGrade"><option value="">（未設定）</option>${gradeOpts}</select></label>`,
    onSave: () => {
      const name = $('#cName').value.trim();
      if (!name) { toast('請輸入班級名稱'); return false; }
      const data = { name, grade: $('#cGrade').value };
      if (existing) Object.assign(existing, data); else state.classes.push({ id: uid(), ...data });
      save(); render(); toast('已儲存班級');
      return true;
    },
  });
}

function viewTeachers() {
  const head = `<div class="page-head"><h2>教師</h2><button class="btn" data-action="add-teacher">＋ 新增教師</button></div>`;
  if (state.teachers.length === 0) return head + emptyCard('尚無教師', '設定教師類別、每週節數上限與不排課時段。');
  const rows = state.teachers.map(t => {
    const un = (t.unavailable || []).length;
    return `<tr>
      <td><b>${esc(t.name)}</b></td>
      <td><span class="pill gray">${esc(t.type || '')}</span></td>
      <td>${t.maxPeriods || '—'}</td>
      <td>${teacherLoad(t.id)} 節</td>
      <td>${un ? un + ' 個時段' : '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" data-action="edit-teacher" data-id="${t.id}">✏️</button>
        <button class="icon-btn" data-action="del-teacher" data-id="${t.id}">🗑️</button>
      </td></tr>`;
  }).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>姓名</th><th>類別</th><th>節數上限</th><th>已排</th><th>不排課時段</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function teacherModal(existing) {
  const t = existing || { name: '', type: '級任', maxPeriods: 20, unavailable: [] };
  const typeOpts = TEACHER_TYPES.map(x => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('');
  const days = activeDays();
  const un = new Set(t.unavailable || []);
  let grid = `<table class="avail"><thead><tr><th></th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of lessonPeriods()) {
    grid += `<tr><th>${esc(p.label)}</th>`;
    for (const d of days) {
      if (!periodHasDay(p, d)) { grid += `<td class="slot na" title="此節本日不上課">·</td>`; continue; }
      const s = d + '|' + p.id;
      grid += `<td class="slot ${un.has(s) ? 'off' : ''}" data-action="toggle-avail" data-slot="${s}">${un.has(s) ? '✕' : ''}</td>`;
    }
    grid += `</tr>`;
  }
  grid += `</tbody></table>`;
  openModal({
    title: existing ? '編輯教師' : '新增教師',
    wide: true,
    body: `
      <div class="field-row">
        <label class="field"><span>姓名</span><input type="text" id="tName" value="${esc(t.name)}"></label>
        <label class="field"><span>類別</span><select id="tType">${typeOpts}</select></label>
        <label class="field"><span>每週節數上限</span><input type="number" id="tMax" min="0" max="40" value="${t.maxPeriods || 0}"></label>
      </div>
      <label class="field"><span>不排課時段（點格切換，✕＝不排）</span></label>
      <div id="availGrid">${grid}</div>`,
    onSave: () => {
      const name = $('#tName').value.trim();
      if (!name) { toast('請輸入姓名'); return false; }
      const unavailable = Array.from(document.querySelectorAll('#availGrid td.off')).map(td => td.dataset.slot);
      const data = { name, type: $('#tType').value, maxPeriods: parseInt($('#tMax').value, 10) || 0, unavailable };
      if (existing) Object.assign(existing, data); else state.teachers.push({ id: uid(), ...data });
      save(); render(); toast('已儲存教師');
      return true;
    },
  });
}

function viewSubjects() {
  const head = `<div class="page-head"><h2>科目</h2><button class="btn" data-action="add-subject">＋ 新增科目</button></div>`;
  if (state.subjects.length === 0) return head + emptyCard('尚無科目', '例如：國語、數學、英語、自然、體育…');
  const rows = state.subjects.map(s => `<tr>
    <td><span class="pill" style="background:${s.color};color:${textOn(s.color)}">${esc(s.name)}</span></td>
    <td>${s.needsRoom ? '需專科教室' : '—'}</td>
    <td>${s.needsConsecutive ? '預設連堂' : '—'}</td>
    <td class="row-actions">
      <button class="icon-btn" data-action="edit-subject" data-id="${s.id}">✏️</button>
      <button class="icon-btn" data-action="del-subject" data-id="${s.id}">🗑️</button>
    </td></tr>`).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>科目</th><th>教室需求</th><th>連堂</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function subjectModal(existing) {
  const s = existing || { name: '', color: COLORS[state.subjects.length % COLORS.length], needsRoom: false, needsConsecutive: false };
  openModal({
    title: existing ? '編輯科目' : '新增科目',
    body: `
      <div class="field-row">
        <label class="field" style="flex:2"><span>科目名稱</span><input type="text" id="sName" value="${esc(s.name)}"></label>
        <label class="field" style="flex:1"><span>顏色</span><input type="color" id="sColor" value="${s.color}" style="height:40px;padding:2px"></label>
      </div>
      <label class="checkbox" style="margin-bottom:10px"><input type="checkbox" id="sRoom" ${s.needsRoom ? 'checked' : ''}> 需要專科教室</label>
      <label class="checkbox"><input type="checkbox" id="sConsec" ${s.needsConsecutive ? 'checked' : ''}> 預設需連堂</label>`,
    onSave: () => {
      const name = $('#sName').value.trim();
      if (!name) { toast('請輸入科目名稱'); return false; }
      const data = { name, color: $('#sColor').value, needsRoom: $('#sRoom').checked, needsConsecutive: $('#sConsec').checked };
      if (existing) Object.assign(existing, data); else state.subjects.push({ id: uid(), ...data });
      save(); render(); toast('已儲存科目');
      return true;
    },
  });
}

function viewRooms() {
  const head = `<div class="page-head"><h2>專科教室</h2><button class="btn" data-action="add-room">＋ 新增教室</button></div>`;
  if (state.rooms.length === 0) return head + emptyCard('尚無專科教室', '例如：電腦教室、自然教室、音樂教室、體育館。');
  const rows = state.rooms.map(r => `<tr>
    <td><b>${esc(r.name)}</b></td>
    <td>${refCount(a => assignmentUsesRoom(a, r.id))} 筆配課使用</td>
    <td class="row-actions">
      <button class="icon-btn" data-action="edit-room" data-id="${r.id}">✏️</button>
      <button class="icon-btn" data-action="del-room" data-id="${r.id}">🗑️</button>
    </td></tr>`).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>教室</th><th>使用</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

/* ==========================================================================
   View: 課表輸出
   ========================================================================== */
function viewOutput() {
  if (state.classes.length === 0) return emptyState('尚無資料', '請先建立班級與配課並排課。');
  const conflicts = computeConflicts();
  if (outputMode === 'class') {
    if (!outputClassId || !classById(outputClassId)) outputClassId = state.classes[0].id;
  } else {
    if (state.teachers.length === 0) { outputMode = 'class'; outputClassId = state.classes[0].id; }
    else if (!outputTeacherId || !teacherById(outputTeacherId)) outputTeacherId = state.teachers[0].id;
  }
  const modeSel = `
    <div class="board-toolbar no-print">
      <label>類型：</label>
      <select id="outMode" data-change="out-mode">
        <option value="class" ${outputMode === 'class' ? 'selected' : ''}>班級課表</option>
        <option value="teacher" ${outputMode === 'teacher' ? 'selected' : ''}>教師課表</option>
      </select>
      ${outputMode === 'class'
      ? `<select id="outClass" data-change="out-class">${state.classes.map(c => `<option value="${c.id}" ${c.id === outputClassId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
      : `<select id="outTeacher" data-change="out-teacher">${state.teachers.map(t => `<option value="${t.id}" ${t.id === outputTeacherId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`}
      <button class="ghost" data-action="print-out">🖨️ 列印 / 存 PDF</button>
      <button class="ghost" data-action="csv-out">⬇️ 匯出 CSV (Excel)</button>
    </div>`;
  const grid = outputMode === 'class'
    ? timetableHTML(outputClassId, conflicts, false)
    : teacherTimetableHTML(outputTeacherId, conflicts);
  return `<div class="page-head no-print"><h2>課表輸出</h2></div>${modeSel}
    <div class="card"><div class="card-body"><div class="grid-wrap">${grid}</div></div></div>`;
}

function teacherTimetableHTML(teacherId, conflicts) {
  const days = activeDays();
  const t = teacherById(teacherId);
  // index teacher's slots
  const map = {}; // `${day}|${period}` -> {classId, a, key, group}
  for (const key in state.slots) {
    const a = assignmentById(state.slots[key]);
    if (!a) continue;
    const g = assignmentGroups(a).find(gr => gr.teacherId === teacherId);
    if (!g) continue;
    const [classId, day, period] = key.split('|');
    map[day + '|' + period] = { classId, a, key, group: g };
  }
  let html = `<div class="print-only" style="text-align:center;font-weight:700;font-size:16px;margin-bottom:8px">${esc((t || {}).name || '')} 教師課表</div>`;
  html += `<table class="timetable"><thead><tr><th class="period-th">節次</th>${days.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>`;
  for (const p of state.settings.periods) {
    if (!isLessonPeriod(p)) { html += `<tr class="break-row"><td colspan="${days.length + 1}">${esc(p.label)}</td></tr>`; continue; }
    html += `<tr><td class="period-th">${esc(p.label)}<small>${esc(p.start)}–${esc(p.end)}</small></td>`;
    for (const d of days) {
      const hit = map[d + '|' + p.id];
      if (hit) {
        const color = subjectColor(hit.a.subjectId);
        const conf = conflicts[hit.key];
        html += `<td class="cell"><div class="cell-lesson ${conf ? 'conflict' : ''}" style="background:${color};color:${textOn(color)}">
          ${esc((classById(hit.classId) || {}).name || '')}${hit.group.label ? '(' + esc(hit.group.label) + ')' : ''}<small>${esc(subjectName(hit.a.subjectId))}${hit.group.roomId ? '·' + esc(roomName(hit.group.roomId)) : ''}</small></div></td>`;
      } else html += `<td class="cell ${periodHasDay(p, d) ? '' : 'blocked'}"></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function exportCSV() {
  const days = activeDays();
  let rows = [['節次', ...days.map(d => DAY_LABELS[d])]];
  let title = '';
  if (outputMode === 'class') {
    title = (classById(outputClassId) || {}).name || '班級';
    for (const p of state.settings.periods) {
      if (!isLessonPeriod(p)) continue;
      rows.push([p.label, ...days.map(d => {
        const a = assignmentById(state.slots[slotKey(outputClassId, d, p.id)]);
        return a ? `${subjectName(a.subjectId)}/${teachersLabel(a)}` : '';
      })]);
    }
  } else {
    title = (teacherById(outputTeacherId) || {}).name || '教師';
    const map = {};
    for (const key in state.slots) {
      const a = assignmentById(state.slots[key]);
      if (!a || !assignmentUsesTeacher(a, outputTeacherId)) continue;
      const [classId, day, period] = key.split('|');
      map[day + '|' + period] = `${(classById(classId) || {}).name || ''}/${subjectName(a.subjectId)}`;
    }
    for (const p of state.settings.periods) {
      if (!isLessonPeriod(p)) continue;
      rows.push([p.label, ...days.map(d => map[d + '|' + p.id] || '')]);
    }
  }
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadBlob(csv, `課表_${title}.csv`, 'text/csv;charset=utf-8');
  toast('已匯出 CSV');
}

/* ==========================================================================
   View: 設定
   ========================================================================== */
function viewSettings() {
  const dayToggles = [1, 2, 3, 4, 5, 6, 7].map(d =>
    `<label class="checkbox" style="display:inline-flex;margin-right:14px">
      <input type="checkbox" data-change="day-toggle" data-day="${d}" ${state.settings.days.includes(d) ? 'checked' : ''}> ${DAY_LABELS[d]}
    </label>`).join('');
  const dayCols = activeDays();
  const periodRows = state.settings.periods.map((p, i) => `<tr>
    <td><input type="text" data-change="period-field" data-pid="${p.id}" data-field="label" value="${esc(p.label)}"></td>
    <td><input type="time" data-change="period-field" data-pid="${p.id}" data-field="start" value="${esc(p.start)}"></td>
    <td><input type="time" data-change="period-field" data-pid="${p.id}" data-field="end" value="${esc(p.end)}"></td>
    ${dayCols.map(d => `<td style="text-align:center"><input type="checkbox" data-change="period-day" data-pid="${p.id}" data-day="${d}" ${periodHasDay(p, d) ? 'checked' : ''}></td>`).join('')}
    <td class="row-actions">
      <button class="icon-btn" data-action="move-period-up" data-pid="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-action="move-period-down" data-pid="${p.id}" ${i === state.settings.periods.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" data-action="del-period" data-pid="${p.id}">🗑️</button>
    </td></tr>`).join('');
  return `
    <div class="page-head"><h2>設定</h2></div>
    <div class="card"><div class="card-body">
      <h4 style="margin-top:0">上課日</h4>
      <div>${dayToggles}</div>
    </div></div>
    <div class="card"><div class="card-body">
      <h4 style="margin-top:0">排課選項</h4>
      <label class="checkbox"><input type="checkbox" data-change="toggle-autopair" ${state.settings.autoPairConsecutive !== false ? 'checked' : ''}> 需連堂排課時，自動成對放課（一組 2 節相鄰）</label>
      <p class="hint" style="color:var(--muted);margin-top:8px">開啟時：排一筆「需連堂」的課，會自動把相鄰的一節一起排入（湊成 2 節連堂）。關閉則需手動逐格放；無論開關，需連堂的課若沒有相鄰兩節在一起，都會顯示「連堂未相鄰」提醒。</p>
    </div></div>
    <div class="card"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h4 style="margin:0">節次表</h4>
        <button class="ghost" data-action="add-period">＋ 新增節次</button>
      </div>
      <div class="grid-wrap"><table class="data">
        <thead><tr><th>名稱</th><th>開始</th><th>結束</th>${dayCols.map(d => `<th style="text-align:center">${DAY_LABELS[d]}</th>`).join('')}<th></th></tr></thead>
        <tbody>${periodRows}</tbody>
      </table></div>
      <p class="hint" style="color:var(--muted);margin-top:8px">勾選＝該節在該日<b>有上課</b>（可排課）；未勾的格子在排課盤面顯示為灰色、不能放課。<b>整列都不勾</b>（如午休）則顯示為分隔列。上課日的欄位由上方「上課日」決定。</p>
    </div></div>
    <div class="card"><div class="card-body">
      <h4 style="margin-top:0">關於</h4>
      <p style="color:var(--muted)">課務編排 ${APP_VERSION}　·　資料儲存在本機瀏覽器（IndexedDB）。換裝置或清除瀏覽器資料前，請用右上角「備份」匯出 JSON。</p>
    </div></div>`;
}

/* ==========================================================================
   Backup
   ========================================================================== */
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function backupMenu() {
  openModal({
    title: '備份 / 還原',
    body: `<p>資料只存在這台裝置的瀏覽器。建議定期匯出 JSON 備份，或在換機時匯入。</p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" data-action="export-json">⬇️ 匯出 JSON</button>
        <button class="ghost" data-action="import-json">⬆️ 匯入 JSON</button>
      </div>
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
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const file = inp.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object' || !Array.isArray(data.classes)) throw new Error('格式不符');
        state = migrate(data);
        save(); closeModal(); selectedClassId = null; render(); toast('已匯入備份');
      } catch (e) { toast('匯入失敗：' + e.message); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

/* ==========================================================================
   使用說明
   ========================================================================== */
function helpModal() {
  openModal({ title: '使用說明　·　' + APP_VERSION, wide: true, body: helpContent() });
}
function helpContent() {
  return `<div class="help">
    <div class="help-note">📌 <b>三個重點：</b>①免安裝免登入，用瀏覽器開網址就能用。②資料只存在<b>你這台裝置</b>，不同人／不同裝置各自獨立、看不到彼此。③換裝置或清瀏覽器前，先用右上「備份」匯出。</div>

    <h4>一、建立順序（照這個走最順）</h4>
    <p class="help-flow">設定 ▸ 科目 ▸ 教室 ▸ 教師 ▸ 班級 ▸ <b>配課</b> ▸ <b>排課</b> ▸ 課表輸出</p>
    <p>最少要有 <b>1 個班級、1 個科目、1 位教師</b>，才能建立配課並開始排課。</p>

    <h4>二、各分頁</h4>
    <ul>
      <li><b>設定</b>：勾選上課日；節次表可為<b>每一節 × 每個上課日</b>各自勾選是否上課（例：週三下午不排課，就把那幾節的「週三」取消）。未勾的格子在排課盤面顯示為灰色、不能放課；整列都不勾（午休）則顯示為分隔列。另有「排課選項」可切換是否<b>連堂自動成對放課</b>。</li>
      <li><b>科目</b>：新增名稱＋選顏色（課表上該科的顏色）。「需專科教室／預設連堂」為<b>註記用途</b>，實際設定在「配課」。</li>
      <li><b>教室</b>：建立會搶用的場地（電腦教室、自然教室、體育館…），排課時會檢查同時段是否被兩班同用。</li>
      <li><b>教師</b>：姓名、類別、<b>每週節數上限</b>；下方格子點一下出現 <b>✕</b> ＝該時段不排課（再點取消）。</li>
      <li><b>班級</b>：新增班名並選年級。</li>
      <li><b>配課</b>：一筆＝一門課＝<b>班級 × 科目 × 教師 × 每週節數</b>（可指定教室／連堂）。這是排課的清單。
        <br>👥 <b>分組教學</b>：同一時段一個班拆成幾組、不同老師（如英語依程度分兩組）。在配課的「授課教師／分組」按「＋ 新增分組」加到 2 列以上即可，各組可設自己的老師與教室；排課時該格會同時佔用各組老師，衝堂檢查逐組進行。
        <br>⏱ <b>需連堂</b>：勾了的課代表兩節要<b>相鄰接續上</b>（同一天、中間不隔開，一組 2 節）。排課時只要放一格，會自動把相鄰的一節一起排入；若沒有相鄰兩節在一起會顯示「連堂未相鄰」。可在「設定 ▸ 排課選項」關閉自動成對。
        <br>🔗 <b>協同教學</b>：若某課要幾個班<b>同時段一起上</b>（如一忠、一孝的生活課），在配課裡勾選要協同的其他班（同科目）。排課時只要排其中一班，其他班會<b>自動排到同一格</b>；同群組彼此不算衝堂，若沒對齊會顯示「協同未同步」。</li>
    </ul>

    <h4>三、排課（核心）</h4>
    <ol>
      <li>上方選<b>班級</b>。</li>
      <li>左側「配課調色盤」<b>點一筆配課</b>（亮藍框），右邊數字 <code>已排/應排</code>。</li>
      <li><b>點課表空格</b> → 放入該節；<b>點已排的格子</b> → 移除。</li>
    </ol>
    <p>系統即時檢查並以 🔴 <b>紅框＋「⚠ 衝堂」</b>標示（游標移上去看原因）：</p>
    <ul>
      <li><b>教師衝堂</b>：同一老師同一時段被排到兩班。</li>
      <li><b>教室衝堂</b>：同一間專科教室同時段被兩班搶用。</li>
      <li><b>教師不排課時段</b>：排到該老師設定的不排課格。</li>
    </ul>
    <p>上方紅色橫幅顯示全校衝堂數；下方「<b>教師節數負荷</b>」顯示各老師已排／上限，超過變紅。<b>系統只提醒、不阻止</b>，是否調整由你決定。</p>

    <h4>四、課表輸出</h4>
    <p>選「班級課表／教師課表」與對象 → <b>🖨️ 列印/存 PDF</b>（列印時選「另存為 PDF」）或 <b>⬇️ 匯出 CSV</b>（Excel 可開，中文正常）。</p>

    <h4>五、備份與換裝置（重要）</h4>
    <p>右上「<b>備份</b>」→ <b>匯出 JSON</b>（定期存一份）／<b>匯入 JSON</b>（<span style="color:var(--danger)">會覆蓋現有資料</span>）。換電腦：舊機匯出、新機匯入。</p>

    <h4>六、常見問題</h4>
    <ul>
      <li><b>同事看得到我的課表／能共編嗎？</b>目前不行，各自獨立。要共編需之後升級雲端協作版。</li>
      <li><b>重整會不會不見？</b>不會，自動存瀏覽器；但清除瀏覽器資料／無痕視窗會清掉，靠備份。</li>
      <li><b>老師刪不掉？</b>該老師還被配課使用中會被擋，請先改／刪相關配課。</li>
      <li><b>手機平板？</b>可以，瀏覽器選單「加入主畫面」即可像 App 使用、離線可用。</li>
    </ul>

    <div class="help-note">回報問題請描述：<b>在哪一頁、做了什麼、預期看到什麼、實際看到什麼</b>。Issues：github.com/calvincat-ship-it/course-scheduler/issues</div>
  </div>`;
}

/* ==========================================================================
   Shared UI bits
   ========================================================================== */
function emptyState(title, sub) {
  return `<div class="card"><div class="empty"><div style="font-size:18px;font-weight:700;margin-bottom:6px">${esc(title)}</div><div>${esc(sub)}</div></div></div>`;
}
function emptyCard(title, sub) {
  return `<div class="card"><div class="empty"><b>${esc(title)}</b><div style="margin-top:4px">${esc(sub)}</div></div></div>`;
}

function confirmDelete(msg, fn) {
  openModal({
    title: '確認刪除', body: `<p>${esc(msg)}</p>`, saveLabel: '刪除',
    onSave: () => { fn(); save(); render(); toast('已刪除'); return true; },
  });
  // make the save button danger
  const btn = $('#modalRoot [data-action="modal-save"]');
  if (btn) btn.classList.add('danger');
}

/* ==========================================================================
   Delete with reference checks
   ========================================================================== */
function delClass(id) {
  const c = classById(id); if (!c) return;
  const n = assignmentsForClass(id).length;
  confirmDelete(`刪除「${c.name}」？將一併移除其 ${n} 筆配課與已排課表。`, () => {
    state.assignments = state.assignments.filter(a => a.classId !== id);
    for (const k in state.slots) if (k.startsWith(id + '|')) delete state.slots[k];
    state.classes = state.classes.filter(x => x.id !== id);
    if (selectedClassId === id) selectedClassId = null;
  });
}
function delTeacher(id) {
  const t = teacherById(id); if (!t) return;
  const n = refCount(a => assignmentUsesTeacher(a, id));
  if (n > 0) { toast(`「${t.name}」仍有 ${n} 筆配課，請先改配課再刪除。`); return; }
  confirmDelete(`刪除教師「${t.name}」？`, () => { state.teachers = state.teachers.filter(x => x.id !== id); });
}
function delSubject(id) {
  const s = subjectById(id); if (!s) return;
  const n = refCount(a => a.subjectId === id);
  if (n > 0) { toast(`「${s.name}」仍有 ${n} 筆配課，請先改配課再刪除。`); return; }
  confirmDelete(`刪除科目「${s.name}」？`, () => { state.subjects = state.subjects.filter(x => x.id !== id); });
}
function delRoom(id) {
  const r = roomById(id); if (!r) return;
  const uses = state.assignments.filter(a => assignmentUsesRoom(a, id));
  confirmDelete(`刪除教室「${r.name}」？${uses.length ? '（' + uses.length + ' 筆配課的教室將清空）' : ''}`, () => {
    uses.forEach(a => assignmentGroups(a).forEach(g => { if (g.roomId === id) g.roomId = ''; }));
    state.rooms = state.rooms.filter(x => x.id !== id);
  });
}
function delAssignment(id) {
  const a = assignmentById(id); if (!a) return;
  const placed = placedCount(id);
  confirmDelete(`刪除此配課（${subjectName(a.subjectId)}）？${placed ? '已排的 ' + placed + ' 節將一併移除。' : ''}`, () => {
    for (const k in state.slots) if (state.slots[k] === id) delete state.slots[k];
    state.assignments = state.assignments.filter(x => x.id !== id);
    cleanupCoteachSingletons();
    if (selectedAssignmentId === id) selectedAssignmentId = null;
  });
}

/* ==========================================================================
   Event handling (delegation)
   ========================================================================== */
const clickHandlers = {
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'modal-close': closeModal,
  'modal-save': () => { const r = modalOnSave ? modalOnSave() : true; if (r !== false) closeModal(); },

  'add-class': () => classModal(null),
  'edit-class': el => classModal(classById(el.dataset.id)),
  'del-class': el => delClass(el.dataset.id),

  'add-teacher': () => teacherModal(null),
  'edit-teacher': el => teacherModal(teacherById(el.dataset.id)),
  'del-teacher': el => delTeacher(el.dataset.id),
  'toggle-avail': el => { el.classList.toggle('off'); el.textContent = el.classList.contains('off') ? '✕' : ''; },

  'add-subject': () => subjectModal(null),
  'edit-subject': el => subjectModal(subjectById(el.dataset.id)),
  'del-subject': el => delSubject(el.dataset.id),

  'add-room': () => roomModal(null),
  'edit-room': el => roomModal(roomById(el.dataset.id)),
  'del-room': el => delRoom(el.dataset.id),

  'add-group-row': () => { syncGroupsFromDOM(); modalGroups.push({ teacherId: state.teachers[0].id, roomId: '', label: '' }); refreshGroupsEditor(); },
  'del-group-row': el => { syncGroupsFromDOM(); modalGroups.splice(parseInt(el.dataset.idx, 10), 1); if (modalGroups.length === 0) modalGroups.push({ teacherId: state.teachers[0].id, roomId: '', label: '' }); refreshGroupsEditor(); },

  'add-assignment': () => assignmentModal(null),
  'edit-assignment': el => assignmentModal(assignmentById(el.dataset.id)),
  'del-assignment': el => delAssignment(el.dataset.id),

  'select-assignment': el => {
    selectedAssignmentId = (selectedAssignmentId === el.dataset.id) ? null : el.dataset.id;
    render();
  },
  'cell-click': el => {
    const key = el.dataset.key;
    const [, day, period] = key.split('|');
    if (state.slots[key]) {
      const a = assignmentById(state.slots[key]);
      delete state.slots[key];
      // 協同：一併移除同群組其他班同一格
      if (a && a.coteach) coteachMembers(a.coteach).forEach(m => {
        if (m.id === a.id) return;
        const mk = slotKey(m.classId, day, period);
        if (state.slots[mk] === m.id) delete state.slots[mk];
      });
      save(); render(); return;
    }
    if (!selectedAssignmentId) { toast('先在左側點選一個配課'); return; }
    const sel = assignmentById(selectedAssignmentId);
    const dNum = parseInt(day, 10);
    const notes = [];
    const linked = placeAssignment(sel, day, period);   // 主格（含協同同步）
    if (linked) notes.push(`協同同步 ${linked} 班`);
    // 連堂：自動把相鄰一節成對排入
    if (sel.consecutive && sel.periods >= 2 && state.settings.autoPairConsecutive !== false && placedCount(sel.id) < sel.periods) {
      const next = adjacentLessonPeriod(period, dNum, +1);
      const prev = adjacentLessonPeriod(period, dNum, -1);
      const partner = (next && !state.slots[slotKey(sel.classId, day, next)]) ? next
        : (prev && !state.slots[slotKey(sel.classId, day, prev)]) ? prev : null;
      if (partner) { const l2 = placeAssignment(sel, day, partner); notes.push('連堂成對排入相鄰節' + (l2 ? `（協同 ${l2} 班）` : '')); }
      else notes.push('連堂：找不到相鄰空格，請手動調整');
    }
    save(); render();
    if (notes.length) toast(notes.join('；'));
  },

  'add-period': () => {
    state.settings.periods.push({ id: uid(), label: '新節次', start: '00:00', end: '00:00', days: state.settings.days.slice() });
    save(); render();
  },
  'del-period': el => {
    const pid = el.dataset.pid;
    // remove any placed slots on this period
    for (const k in state.slots) if (k.endsWith('|' + pid)) delete state.slots[k];
    state.settings.periods = state.settings.periods.filter(p => p.id !== pid);
    save(); render();
  },
  'move-period-up': el => movePeriod(el.dataset.pid, -1),
  'move-period-down': el => movePeriod(el.dataset.pid, 1),

  'print-out': () => window.print(),
  'csv-out': exportCSV,

  'export-json': exportJSON,
  'import-json': importJSON,
};

function movePeriod(pid, dir) {
  const arr = state.settings.periods;
  const i = arr.findIndex(p => p.id === pid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  save(); render();
}

const changeHandlers = {
  'schedule-class': el => { selectedClassId = el.value; selectedAssignmentId = null; render(); },
  'out-mode': el => { outputMode = el.value; render(); },
  'out-class': el => { outputClassId = el.value; render(); },
  'out-teacher': el => { outputTeacherId = el.value; render(); },
  'day-toggle': el => {
    const d = parseInt(el.dataset.day, 10);
    if (el.checked) { if (!state.settings.days.includes(d)) state.settings.days.push(d); }
    else state.settings.days = state.settings.days.filter(x => x !== d);
    save(); render();
  },
  'period-field': el => {
    const p = byId(state.settings.periods, el.dataset.pid);
    if (p) { p[el.dataset.field] = el.value; save(); }
  },
  'toggle-autopair': el => { state.settings.autoPairConsecutive = el.checked; save(); },
  'period-day': el => {
    const p = byId(state.settings.periods, el.dataset.pid);
    if (!p) return;
    const d = parseInt(el.dataset.day, 10);
    p.days = p.days || [];
    if (el.checked) { if (!p.days.includes(d)) p.days.push(d); }
    else p.days = p.days.filter(x => x !== d);
    save(); render();
  },
};

function bindGlobal() {
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    currentTab = b.dataset.tab;
    render();
  });
  $('#backupBtn').addEventListener('click', backupMenu);
  $('#helpBtn').addEventListener('click', helpModal);
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = clickHandlers[el.dataset.action];
    if (fn) fn(el, e);
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const fn = changeHandlers[el.dataset.change];
    if (fn) fn(el, e);
  });
  $('#versionTag').textContent = APP_VERSION;
}

/* ==========================================================================
   Init
   ========================================================================== */
async function init() {
  try {
    state = await idbGet(STATE_KEY);
  } catch (e) { state = null; }
  if (!state) { state = defaultState(); await save(); }
  else migrate(state);
  bindGlobal();
  render();
  if (!state.helpSeen) { helpModal(); state.helpSeen = true; save(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}
init();
