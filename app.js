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
    case 'classes': view.innerHTML = viewClasses(); break;
    case 'teachers': view.innerHTML = viewTeachers(); break;
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
  state.teachers.forEach(t => (t.load || []).forEach(L => { if (L.classId === classId && L.subjectId === sid) out.push({ teacher: t, hours: L.hours }); }));
  return out;
}
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
      } else {
        const total = loads.reduce((a, x) => a + x.hours, 0);
        if (total !== required) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: total < required ? `缺漏（少 ${required - total} 節）` : `超過（多 ${total - required} 節）`, teacherNames });
        else if (loads.length > 1) problems.push({ className: c.name, subjectName: subjectName(sh.subjectId), required, status: '非分組科目卻有多位老師', teacherNames });
      }
    });
  });
  return problems;
}

function viewTeachers() {
  const problems = checkStaffing();
  const statusCard = state.classes.length === 0
    ? `<div class="card"><div class="card-body"><span style="color:var(--muted)">尚無班級，請先完成「③ 班級」。</span></div></div>`
    : `<div class="card"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>${problems.length === 0
          ? '<b style="color:var(--ok)">✓ 全校配課相符</b>　各班每科節數皆由教師配課填滿，可進入 ⑤ 排課。'
          : `<b style="color:var(--danger)">⚠ 有 ${problems.length} 項配課問題</b>　各班每科節數尚未由教師配課正確填滿。`}</div>
        <button class="ghost" data-action="check-staffing">檢查全校配課</button>
      </div></div>`;
  const head = `<div class="page-head"><h2>④ 教師</h2><button class="btn" data-action="add-teacher">＋ 新增教師</button></div>
    <div class="hint" style="margin-bottom:12px;color:var(--muted)">填入教師基本資料與不排課時段，並設定其配課（教哪個班的哪一科幾節）。每位教師配課合計須等於其每周授課時數才可儲存。</div>`;
  if (state.teachers.length === 0) return head + statusCard + emptyCard('尚無教師', '新增教師並設定配課。');
  const rows = state.teachers.map(t => {
    const sum = teacherLoadSum(t); const match = sum === (t.weeklyHours || 0);
    return `<tr>
      <td><b>${esc(t.name)}</b></td>
      <td><span class="pill gray">${esc(t.type || '')}</span></td>
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
function loadEditorHTML() {
  if (state.classes.length === 0) return `<div class="hint" style="color:var(--muted)">尚無班級，請先到「③ 班級」建立。</div>`;
  const clsOpts = sel => state.classes.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}（${esc(gradeName(c.gradeId))}）</option>`).join('');
  const subOpts = (classId, sel) => {
    const c = classById(classId); const subs = c ? classSubjectHours(c) : [];
    if (!subs.length) return `<option value="">（該班無科目）</option>`;
    return subs.map(sh => `<option value="${sh.subjectId}" ${sh.subjectId === sel ? 'selected' : ''}>${esc(subjectName(sh.subjectId))}（需${sh.hours}節）</option>`).join('');
  };
  const rows = modalLoad.map((L, i) => `<div class="group-row" data-idx="${i}">
      <select class="ld-class" data-change="load-class" data-idx="${i}">${clsOpts(L.classId)}</select>
      <select class="ld-subject">${subOpts(L.classId, L.subjectId)}</select>
      <input type="number" class="ld-hours" data-change="load-hours" min="0" max="40" value="${L.hours || ''}" placeholder="節" style="width:64px">
      <button type="button" class="icon-btn" data-action="del-load-row" data-idx="${i}">🗑️</button>
    </div>`).join('');
  return rows + `<button type="button" class="ghost" data-action="add-load-row" style="margin-top:6px;padding:5px 10px;font-size:13px">＋ 新增配課（班級 → 科目 → 節數）</button>`;
}
function syncLoadFromDOM() {
  modalLoad = Array.from(document.querySelectorAll('#loadEditor .group-row')).map(r => ({
    classId: r.querySelector('.ld-class').value,
    subjectId: r.querySelector('.ld-subject').value,
    hours: parseInt(r.querySelector('.ld-hours').value, 10) || 0,
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
  modalLoad = (t.load || []).map(L => ({ ...L }));
  const typeOpts = TEACHER_TYPES.map(x => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('');
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
        <label class="field"><span>身分別</span><select id="tType">${typeOpts}</select></label>
        <label class="field"><span>每周授課時數</span><input type="number" id="tWeekly" data-change="weekly-hours" min="0" max="40" value="${t.weeklyHours || 0}"></label>
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
      const sum = load.reduce((s, L) => s + L.hours, 0);
      if (sum !== weekly) { toast(`配課合計 ${sum} 節與每周授課 ${weekly} 節不符，無法儲存`); return false; }
      const unavailable = Array.from(document.querySelectorAll('#availGrid td.off')).map(td => td.dataset.slot);
      const data = { name, type: $('#tType').value, weeklyHours: weekly, unavailable, load };
      if (existing) Object.assign(existing, data); else state.teachers.push({ id: uid(), ...data });
      save(); render(); toast('已儲存教師');
      return true;
    },
  });
  updateLoadSum();
}
function delTeacher(id) {
  const t = teacherById(id); if (!t) return;
  confirmDelete(`刪除教師「${t.name}」？其配課將一併移除。`, () => { state.teachers = state.teachers.filter(x => x.id !== id); });
}
function staffingReportModal() {
  const problems = checkStaffing();
  const body = problems.length === 0
    ? `<div class="total-badge ok">✓ 全校各班每科節數皆已由教師配課正確填滿，可進入 ⑤ 排課。</div>`
    : `<p style="color:var(--danger);font-weight:700;margin-top:0">有 ${problems.length} 項問題，請修正後再排課：</p>
       <table class="data"><thead><tr><th>班級</th><th>科目</th><th>應配</th><th>狀況</th><th>目前老師</th></tr></thead>
       <tbody>${problems.map(p => `<tr>
         <td>${esc(p.className)}</td><td>${esc(p.subjectName)}</td><td>${p.required} 節</td>
         <td style="color:var(--danger);font-weight:600">${esc(p.status)}</td><td>${esc(p.teacherNames)}</td>
       </tr>`).join('')}</tbody></table>`;
  openModal({ title: '全校配課檢查', wide: true, body });
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

  'add-teacher': () => teacherModal(null),
  'edit-teacher': el => teacherModal(teacherById(el.dataset.id)),
  'del-teacher': el => delTeacher(el.dataset.id),
  'check-staffing': () => staffingReportModal(),
  'toggle-avail': el => { el.classList.toggle('off'); el.textContent = el.classList.contains('off') ? '✕' : ''; },
  'add-load-row': () => { syncLoadFromDOM(); modalLoad.push({ classId: state.classes[0] ? state.classes[0].id : '', subjectId: '', hours: 0 }); const c = state.classes[0]; if (c) { const subs = classSubjectHours(c); modalLoad[modalLoad.length - 1].subjectId = subs[0] ? subs[0].subjectId : ''; } refreshLoadEditor(); updateLoadSum(); },
  'del-load-row': el => { syncLoadFromDOM(); modalLoad.splice(parseInt(el.dataset.idx, 10), 1); refreshLoadEditor(); updateLoadSum(); },

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
  'load-class': el => {
    syncLoadFromDOM();
    const idx = parseInt(el.dataset.idx, 10);
    const c = classById(el.value); const subs = c ? classSubjectHours(c) : [];
    modalLoad[idx].classId = el.value;
    modalLoad[idx].subjectId = subs[0] ? subs[0].subjectId : '';
    refreshLoadEditor(); updateLoadSum();
  },
  'load-hours': () => updateLoadSum(),
  'weekly-hours': () => updateLoadSum(),

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
