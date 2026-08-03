'use strict';

/* ==========================================================================
   課務編排 v02（redesign）— 前後參照流程
   科目 → 年級(節次表+科目節數) → 班級 → 教師(配課) → 排課
   資料層：IndexedDB 單一 state 文件（schema:2）
   ========================================================================== */

const APP_VERSION = 'v02.00';
const DB_NAME = 'course_scheduler';
const STATE_KEY = 'state';
const SCHEMA = 2;

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
    settings: { days, periods, autoPairConsecutive: true },
    subjects: [],
    grades,
    classes: [],
    teachers: [],
    slots: {},
    helpSeen: true,
  };
}

async function save() { await idbSet(STATE_KEY, state); }

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function esc(str) { return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const byId = (arr, id) => arr.find(x => x.id === id);
const subjectById = id => byId(state.subjects, id);
const gradeById = id => byId(state.grades, id);
const classById = id => byId(state.classes, id);
const teacherById = id => byId(state.teachers, id);
const subjectName = id => (subjectById(id) || {}).name || '?';
const gradeName = id => (gradeById(id) || {}).name || '?';
const activeDays = () => state.settings.days.slice().sort((a, b) => a - b);
const lessonPeriods = () => state.settings.periods.filter(p => !p.isBreak);

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

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  const view = $('#view');
  switch (currentTab) {
    case 'subjects': view.innerHTML = viewSubjects(); break;
    case 'grades': view.innerHTML = viewGrades(); break;
    case 'classes': view.innerHTML = stubView('③ 班級', 'Batch 2'); break;
    case 'teachers': view.innerHTML = stubView('④ 教師 / 教師配課', 'Batch 3'); break;
    case 'schedule': view.innerHTML = stubView('⑤ 排課', 'Batch 4'); break;
    case 'output': view.innerHTML = stubView('課表輸出', 'Batch 4'); break;
    case 'settings': view.innerHTML = viewSettings(); break;
  }
}
function stubView(title, batch) {
  return `<div class="page-head"><h2>${esc(title)}</h2></div>
    <div class="card"><div class="empty"><b>此步驟開發中（${esc(batch)}）</b>
    <div style="margin-top:6px">重構分批進行中，這一頁會在後續批次完成。</div></div></div>`;
}

/* ==========================================================================
   ① 科目
   ========================================================================== */
function viewSubjects() {
  const head = `<div class="page-head"><h2>① 科目</h2><button class="btn" data-action="add-subject">＋ 新增科目</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">先建立全校要開的科目。勾「可分組教學」的科目：同一班可由多位老師同時分組上課（配課不計教師衝堂、排課可放同一節）。</div>`;
  if (state.subjects.length === 0) return head + emptyCard('尚無科目', '例如：國語、數學、英語、自然、體育、藝術…');
  const rows = state.subjects.map(s => `<tr>
    <td><span class="pill" style="background:${s.color};color:${textOn(s.color)}">${esc(s.name)}</span></td>
    <td>${s.allowGrouping ? '<span class="pill amber">👥 可分組</span>' : '<span style="color:var(--muted)">—</span>'}</td>
    <td class="row-actions">
      <button class="icon-btn" data-action="edit-subject" data-id="${s.id}">✏️</button>
      <button class="icon-btn" data-action="del-subject" data-id="${s.id}">🗑️</button>
    </td></tr>`).join('');
  return head + `<div class="card"><table class="data">
    <thead><tr><th>科目</th><th>分組教學</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function subjectModal(existing) {
  const s = existing || { name: '', color: COLORS[state.subjects.length % COLORS.length], allowGrouping: false };
  openModal({
    title: existing ? '編輯科目' : '新增科目',
    body: `
      <div class="field-row">
        <label class="field" style="flex:2"><span>科目名稱</span><input type="text" id="sName" value="${esc(s.name)}"></label>
        <label class="field" style="flex:1"><span>顏色</span><input type="color" id="sColor" value="${s.color}" style="height:40px;padding:2px"></label>
      </div>
      <label class="checkbox"><input type="checkbox" id="sGroup" ${s.allowGrouping ? 'checked' : ''}> 👥 可分組教學（同班多師同時上，配課不計教師衝堂、排課可同節）</label>`,
    onSave: () => {
      const name = $('#sName').value.trim();
      if (!name) { toast('請輸入科目名稱'); return false; }
      const data = { name, color: $('#sColor').value, allowGrouping: $('#sGroup').checked };
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
    <div class="card"><div class="card-body"><h4 style="margin-top:0">排課選項</h4>
      <label class="checkbox"><input type="checkbox" data-change="toggle-autopair" ${state.settings.autoPairConsecutive !== false ? 'checked' : ''}> 需連堂排課時，自動成對放課（一組 2 節相鄰）</label>
    </div></div>
    <div class="card"><div class="card-body"><h4 style="margin-top:0">關於</h4>
      <p style="color:var(--muted)">課務編排 ${APP_VERSION}（重構測試中）· 資料存本機瀏覽器。備份請用右上「備份」。</p>
    </div></div>`;
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
        state = data; save(); closeModal(); selectedGradeId = null; render(); toast('已匯入備份');
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
   Events
   ========================================================================== */
const clickHandlers = {
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'modal-close': closeModal,
  'modal-save': () => { const r = modalOnSave ? modalOnSave() : true; if (r !== false) closeModal(); },

  'add-subject': () => subjectModal(null),
  'edit-subject': el => subjectModal(subjectById(el.dataset.id)),
  'del-subject': el => delSubject(el.dataset.id),

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

  'export-json': exportJSON,
  'import-json': importJSON,
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
  const help = $('#helpBtn'); if (help) help.addEventListener('click', () => toast('使用說明將於重構完成後更新'));
  document.addEventListener('click', e => { const el = e.target.closest('[data-action]'); if (!el) return; const fn = clickHandlers[el.dataset.action]; if (fn) fn(el, e); });
  document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (!el) return; const fn = changeHandlers[el.dataset.change]; if (fn) fn(el, e); });
  $('#versionTag').textContent = APP_VERSION;
}

/* ---------- Init ---------- */
async function init() {
  try { state = await idbGet(STATE_KEY); } catch (e) { state = null; }
  if (!state || state.schema !== SCHEMA) { state = defaultState(); await save(); }
  bindGlobal();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
}
init();
