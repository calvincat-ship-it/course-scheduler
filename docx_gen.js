/* 純前端 .docx 產生器（無依賴）— 課務編排：所有班級 / 所有教師課表，每頁一張，格式比照範本 */
(function (root) {
  'use strict';

  /* ---------- ZIP (store, 無壓縮) ---------- */
  var CRC = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function strU8(s) { return new TextEncoder().encode(s); }
  function num(arr, v, n) { for (var i = 0; i < n; i++) { arr.push(v & 0xFF); v >>>= 8; } }
  function zipStore(files) {
    // files: [{name, data(Uint8Array)}]
    var local = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = strU8(f.name), crc = crc32(f.data), sz = f.data.length;
      var lh = []; num(lh, 0x04034b50, 4); num(lh, 20, 2); num(lh, 0x0800, 2); num(lh, 0, 2); num(lh, 0, 2); num(lh, 0, 2); num(lh, crc, 4); num(lh, sz, 4); num(lh, sz, 4); num(lh, name.length, 2); num(lh, 0, 2);
      var lhu = new Uint8Array(lh);
      local.push(lhu, name, f.data);
      var ch = []; num(ch, 0x02014b50, 4); num(ch, 20, 2); num(ch, 20, 2); num(ch, 0x0800, 2); num(ch, 0, 2); num(ch, 0, 2); num(ch, 0, 2); num(ch, crc, 4); num(ch, sz, 4); num(ch, sz, 4); num(ch, name.length, 2); num(ch, 0, 2); num(ch, 0, 2); num(ch, 0, 2); num(ch, 0, 2); num(ch, 0, 4); num(ch, offset, 4);
      central.push(new Uint8Array(ch), name);
      offset += lhu.length + name.length + sz;
    });
    var cs = offset, clen = 0; central.forEach(function (u) { clen += u.length; });
    var eo = []; num(eo, 0x06054b50, 4); num(eo, 0, 2); num(eo, 0, 2); num(eo, files.length, 2); num(eo, files.length, 2); num(eo, clen, 4); num(eo, cs, 4); num(eo, 0, 2);
    var parts = local.concat(central, [new Uint8Array(eo)]);
    var total = 0; parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), pos = 0; parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------- XML helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]; }); }
  function runs(text, o) {
    o = o || {}; var sz = o.sz || 18, lines = String(text == null ? '' : text).split('\n');
    var rpr = '<w:rPr>' + (o.bold ? '<w:b/>' : '') + '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:rFonts w:eastAsia="標楷體" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr>';
    var inner = '';
    lines.forEach(function (ln, i) { if (i) inner += '<w:br/>'; inner += '<w:t xml:space="preserve">' + esc(ln) + '</w:t>'; });
    return '<w:r>' + rpr + inner + '</w:r>';
  }
  // cell: {t, span, vm:'restart'|'continue', bold, sz, shade, w}
  function tc(c) {
    var pr = '<w:tcPr>';
    pr += '<w:tcW w:w="' + (c.w || 0) + '" w:type="' + (c.w ? 'dxa' : 'auto') + '"/>';
    if (c.span) pr += '<w:gridSpan w:val="' + c.span + '"/>';
    if (c.vm) pr += '<w:vMerge w:val="' + c.vm + '"/>';
    if (c.shade) pr += '<w:shd w:val="clear" w:color="auto" w:fill="' + c.shade + '"/>';
    pr += '<w:vAlign w:val="center"/></w:tcPr>';
    var body = (c.vm === 'continue') ? '<w:p/>' :
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' + runs(c.t, c) + '</w:p>';
    return '<w:tc>' + pr + body + '</w:tc>';
  }
  function tr(cells) { return '<w:tr>' + cells.map(tc).join('') + '</w:tr>'; }
  function table(grid, cols) {
    var borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (s) { return '<w:' + s + ' w:val="single" w:sz="6" w:space="0" w:color="000000"/>'; }).join('');
    var g = '<w:tblGrid>' + cols.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>';
    var pr = '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/><w:tblBorders>' + borders + '</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr>';
    return '<w:tbl>' + pr + g + grid.map(tr).join('') + '</w:tbl>';
  }
  function pageBreak() { return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; }
  function docWrap(bodyInner) {
    var sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="680" w:right="900" w:bottom="680" w:left="900" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      bodyInner + sect + '</w:body></w:document>';
  }
  function pack(documentXml) {
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: strU8(ct) },
      { name: '_rels/.rels', data: strU8(rels) },
      { name: 'word/document.xml', data: strU8(documentXml) }
    ]);
  }

  /* ---------- 課表資料模型 ---------- */
  // 固定列: [節次, 分鐘, 起, 迄, kind, pid?]
  var ROWS = [
    ['', '20', '07：50', '08：10', 'clean'],
    ['', '20', '08：10', '08：30', 'duty'],
    ['１', '40', '08：40', '09：20', 'period', 'p1'],
    ['２', '40', '09：30', '10：10', 'period', 'p2'],
    ['３', '40', '10：30', '11：10', 'period', 'p3'],
    ['４', '40', '11：20', '12：00', 'period', 'p4'],
    ['', '40', '12：00', '12：40', 'lunch'],
    ['', '25', '12：40', '13：05', 'rest'],
    ['５', '40', '13：10', '13：50', 'period', 'p5'],
    ['６', '40', '14：00', '14：40', 'period', 'p6'],
    ['７', '40', '14：50', '15：30', 'period', 'p7'],
    ['８', '40', '15：40', '16：20', 'period8']
  ];
  var DAYS = [1, 2, 3, 4, 5], DNAME = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' };
  var DEFAULT_MAP = {
    '國語': '國語', '數學': '數學', '社會': '社會', '自然': '自然', '英語': '英語', '綜合': '綜合',
    '生活': '生活', '健康': '健康', '體育': '體育', '美勞': '藝文', '音樂': '音樂',
    '國語補救': '國語補救', '數學補救': '數學補救',
    '彈性資訊': '資訊', '彈性英語': '彈性英語', '彈性閱讀': '閱讀', '彈性在地': '文化',
    '母語課程': '阿美語/閩南語', '國際教育': '國際教育'
  };

  function build(S, opts) {
    opts = opts || {};
    var MAP = Object.assign({}, DEFAULT_MAP, opts.subjectMap || {});
    var SCHOOL = opts.school || '臺東縣成功鎮三民國民小學';
    var YEAR = opts.year || '113';
    var subs = {}; S.subjects.forEach(function (s) { subs[s.id] = s; });
    var classes = {}; S.classes.forEach(function (c) { classes[c.id] = c; });
    var grades = {}; S.grades.forEach(function (g) { grades[g.id] = g; });
    var teachers = {}; S.teachers.forEach(function (t) { teachers[t.id] = t; });
    var slots = S.slots || {}, sTea = S.slotTeachers || {};
    var mapName = function (sid) { var s = subs[sid]; return s ? (MAP[s.name] != null ? MAP[s.name] : s.name) : ''; };
    var gradeOf = function (cid) { return grades[classes[cid].gradeId]; };
    var gradeOpen = function (g, pid, day) { var a = g.periodDays[pid] || []; return a.indexOf(day) >= 0; };
    // (class,subject)->[{tid,hours,room}]
    var loadIdx = {};
    S.teachers.forEach(function (t) { (t.load || []).forEach(function (L) { var k = L.classId + '|' + L.subjectId; (loadIdx[k] = loadIdx[k] || []).push({ tid: t.id, hours: L.hours, room: L.roomId }); }); });
    var subjTeachers = function (cid, sid) { return (loadIdx[cid + '|' + sid] || []).map(function (x) { return teachers[x.tid].name; }); };

    var COLS_C = [720, 620, 1180, 1150, 1150, 1150, 1150, 1150, 1900, 1600]; // class 10 欄
    var COLS_T = [780, 680, 1300, 1560, 1560, 1560, 1560, 1560];            // teacher 8 欄
    var TOTAL_C = 10, TOTAL_T = 8;

    /* 每格日內容 */
    function dutyText(day, isTeacher) { if (day === 3) return '升旗集會'; if (isTeacher && day === 1) return '教師晨會'; return '導師時間'; }
    function restText(day, isTeacher) { if (isTeacher) return '午休/放學'; return day === 3 ? '放學' : '午休時間'; }

    // 週三下午 教研 判斷（此資料 day3 無 p5-7）
    function isResearch(day, pid) { return day === 3 && (pid === 'p5' || pid === 'p6' || pid === 'p7'); }

    /* ---- 班級課表 ---- */
    function classGrid(cid) {
      var c = classes[cid], g = gradeOf(cid), grid = [];
      var title = SCHOOL + ' ' + YEAR + ' 學年度　' + c.name + ' 課表';
      grid.push([{ t: title, span: TOTAL_C, bold: true, sz: 24 }]);
      // header
      grid.push([
        { t: '節\n次', bold: true }, { t: '分\n鐘', bold: true }, { t: '時間＼科目＼星期', bold: true },
        { t: '一', bold: true }, { t: '二', bold: true }, { t: '三', bold: true }, { t: '四', bold: true }, { t: '五', bold: true },
        { t: '科目', bold: true }, { t: '任課老師', bold: true }
      ]);
      // 導師 / 科任 清單
      var homeT = null;
      (S.teachers || []).forEach(function (t) { if (t.type === '級任' && (t.load || []).some(function (L) { return L.classId === cid; })) homeT = t; });
      var homeLoads = homeT ? (homeT.load || []).filter(function (L) { return L.classId === cid; }) : [];
      var homeSids = {}; homeLoads.forEach(function (L) { homeSids[L.subjectId] = 1; });
      var homeSubs = homeLoads.map(function (L) { return mapName(L.subjectId).replace('\n', '/') + ' ' + L.hours; });
      var homeSum = homeLoads.reduce(function (a, L) { return a + L.hours; }, 0);
      var otherSubs = [], otherTeas = [];
      (g.subjectHours || []).forEach(function (sh) {
        if (homeSids[sh.subjectId]) return;                       // 導師已列，科任不重複
        otherSubs.push(mapName(sh.subjectId).replace('\n', '/') + ' ' + sh.hours);
        otherTeas.push(subjTeachers(cid, sh.subjectId).join('、'));
      });
      var legendCol1_top = homeSubs.join('\n'), legendCol2_top = homeT ? (homeT.name + '（' + homeSum + '）') : '';
      var legendCol1_mid = otherSubs.join('\n'), legendCol2_mid = otherTeas.join('\n');

      ROWS.forEach(function (R, ri) {
        var kind = R[4], pid = R[5];
        var row = [
          { t: R[0], bold: true }, { t: R[1] }, { t: R[2] + '\n' + R[3] }
        ];
        DAYS.forEach(function (day) {
          if (kind === 'clean') row.push({ t: '整潔活動' });
          else if (kind === 'duty') row.push({ t: dutyText(day, false) });
          else if (kind === 'lunch') row.push({ t: '午餐時間' });
          else if (kind === 'rest') row.push({ t: restText(day, false) });
          else if (kind === 'period8') row.push({ t: '' });
          else { // period
            if (isResearch(day, pid)) {
              if (pid === 'p5') row.push({ t: '教\n學\n研\n究', vm: 'restart' });
              else row.push({ vm: 'continue' });
            } else {
              var open = gradeOpen(g, pid, day);
              var sid = slots[cid + '|' + day + '|' + pid];
              row.push({ t: sid ? mapName(sid) : '' });
            }
          }
        });
        // 右側兩欄（科目 / 任課老師）用 vMerge 分三塊
        if (ri === 0 + 0) { }
        // block ranges by ROWS index: [0,1,2]=導師, [3,4,5,6,7]=科任, [8]=學生人數header,[9,10,11]=人數/導師
        if (ri === 0) { row.push({ t: legendCol1_top, vm: 'restart' }); row.push({ t: legendCol2_top, vm: 'restart' }); }
        else if (ri >= 1 && ri <= 2) { row.push({ vm: 'continue' }); row.push({ vm: 'continue' }); }
        else if (ri === 3) { row.push({ t: legendCol1_mid, vm: 'restart' }); row.push({ t: legendCol2_mid, vm: 'restart' }); }
        else if (ri >= 4 && ri <= 7) { row.push({ vm: 'continue' }); row.push({ vm: 'continue' }); }
        else if (ri === 8) { row.push({ t: '學生人數', bold: true }); row.push({ t: '級任導師', bold: true }); }
        else if (ri === 9) { row.push({ t: '男　　人\n女　　人\n共　　人', vm: 'restart' }); row.push({ t: homeT ? homeT.name : '', vm: 'restart' }); }
        else { row.push({ vm: 'continue' }); row.push({ vm: 'continue' }); }
        grid.push(row);
      });
      return table(grid, COLS_C);
    }

    /* ---- 教師課表 ---- */
    function teacherGrid(tid) {
      var t = teachers[tid], grid = [];
      var teaches = {}; (t.load || []).forEach(function (L) { teaches[L.classId + '|' + L.subjectId] = 1; });
      // (day|pid) -> [班級\n科目]
      var cell = {};
      Object.keys(slots).forEach(function (key) {
        var sid = slots[key], parts = key.split('|'), cid = parts[0], day = +parts[1], pid = parts[2];
        if (!teaches[cid + '|' + sid]) return;
        var s = subs[sid];
        if (s && s.splitTeachers && sTea[key] !== tid) return;
        (cell[day + '|' + pid] = cell[day + '|' + pid] || []).push(classes[cid].name + '\n' + mapName(sid).replace('\n', '/'));
      });
      var title = SCHOOL + ' ' + YEAR + ' 學年度課表 － ' + t.name + ' 師';
      grid.push([{ t: title, span: TOTAL_T, bold: true, sz: 24 }]);
      grid.push([{ t: '節\n次', bold: true }, { t: '分\n鐘', bold: true }, { t: '時間＼科目＼星期', bold: true },
      { t: '一', bold: true }, { t: '二', bold: true }, { t: '三', bold: true }, { t: '四', bold: true }, { t: '五', bold: true }]);
      ROWS.forEach(function (R) {
        var kind = R[4], pid = R[5];
        var row = [{ t: R[0], bold: true }, { t: R[1] }, { t: R[2] + '\n' + R[3] }];
        DAYS.forEach(function (day) {
          if (kind === 'clean') row.push({ t: '整潔活動' });
          else if (kind === 'duty') row.push({ t: dutyText(day, true) });
          else if (kind === 'lunch') row.push({ t: '午餐時間' });
          else if (kind === 'rest') row.push({ t: restText(day, true) });
          else if (kind === 'period8') row.push({ t: '' });
          else {
            if (isResearch(day, pid)) { if (pid === 'p5') row.push({ t: '教\n學\n研\n究', vm: 'restart' }); else row.push({ vm: 'continue' }); }
            else { var hit = cell[day + '|' + pid]; row.push({ t: hit ? hit.join('\n') : '' }); }
          }
        });
        grid.push(row);
      });
      return table(grid, COLS_T);
    }

    function classesDocx() {
      var body = S.classes.map(function (c, i) { return (i ? pageBreak() : '') + classGrid(c.id); }).join('');
      return pack(docWrap(body));
    }
    function teachersDocx() {
      var body = S.teachers.map(function (t, i) { return (i ? pageBreak() : '') + teacherGrid(t.id); }).join('');
      return pack(docWrap(body));
    }
    return { classesDocx: classesDocx, teachersDocx: teachersDocx };
  }

  var api = { build: build, DEFAULT_MAP: DEFAULT_MAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DocxGen = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
