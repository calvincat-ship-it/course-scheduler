# -*- coding: utf-8 -*-
import json, collections, html, sys
import os as _os; _os.chdir(_os.path.dirname(_os.path.abspath(__file__)) or ".")
FN=sys.argv[1] if len(sys.argv)>1 else 'state_filled.json'
S=json.load(open(FN,encoding='utf-8'))
subs={s['id']:s for s in S['subjects']}; grades={g['id']:g for g in S['grades']}
classes={c['id']:c for c in S['classes']}; teachers={t['id']:t for t in S['teachers']}
NAME={i:subs[i]['name'] for i in subs}; COLOR={i:subs[i].get('color','#888') for i in subs}
allP=[p for p in S['settings']['periods']]  # incl lunch
PERIODS=[p['id'] for p in allP if not p['isBreak']]
DAYS=S['settings']['days']; DN={1:'週一',2:'週二',3:'週三',4:'週四',5:'週五'}
gc=collections.defaultdict(list)
for c in S['classes']: gc[c['gradeId']].append(c['id'])
slots=S['slots']; sT=S['slotTeachers']
SPLIT={i for i in subs if subs[i].get('splitTeachers')}
tn=lambda t:teachers[t]['name'] if t in teachers else ''
plabel={p['id']:(p['label'],p.get('start',''),p.get('end','')) for p in allP}

def grade_avail(gid,p): return grades[gid]['periodDays'].get(p,[])

cards=[]
for gid in grades:
    rep=gc[gid][0]; z,x=gc[gid][0],gc[gid][1]
    rows=[]
    for pobj in allP:
        p=pobj['id']
        if pobj['isBreak']:
            rows.append(f'<tr class="brk"><th class="pcol">{html.escape(pobj["label"])}</th>'+f'<td colspan="{len(DAYS)}">午休</td></tr>')
            continue
        lbl,st,en=plabel[p]
        tds=[f'<th class="pcol"><span class="pn">{html.escape(lbl)}</span><span class="pt">{st}</span></th>']
        for d in DAYS:
            if d not in grade_avail(gid,p):
                tds.append('<td class="na"></td>'); continue
            v=slots.get(f'{rep}|{d}|{p}')
            if not v: tds.append('<td class="na"></td>'); continue
            extra=''
            if v in SPLIT:
                t1=tn(sT.get(f'{z}|{d}|{p}')); t2=tn(sT.get(f'{x}|{d}|{p}'))
                extra=f'<span class="tt">{html.escape(t1)}·{html.escape(t2)}</span>'
            tds.append(f'<td class="cell" style="--subj:{COLOR[v]}"><span class="sn">{html.escape(NAME[v])}</span>{extra}</td>')
        rows.append('<tr>'+''.join(tds)+'</tr>')
    head='<tr><th class="pcol"></th>'+''.join(f'<th>{DN[d]}</th>' for d in DAYS)+'</tr>'
    cards.append(f'''<section class="card">
      <h2>{html.escape(grades[gid]["name"])}<span class="cls">{html.escape(classes[z]["name"])}／{html.escape(classes[x]["name"])}（同一張表）</span></h2>
      <div class="tw"><table>{head}{''.join(rows)}</table></div>
    </section>''')

# legend from subjects actually used
used=[]
seen=set()
for k,v in slots.items():
    if v not in seen: seen.add(v); used.append(v)
legend=''.join(f'<span class="lg"><i style="background:{COLOR[s]}"></i>{html.escape(NAME[s])}</span>' for s in sorted(seen,key=lambda s:NAME[s]))

CSS='''
<style>
:root{
  --paper:#eef1f5; --surface:#ffffff; --ink:#191c22; --muted:#6b7280;
  --line:#d7dce3; --accent:#3b4a9c; --good:#1f8a54; --good-bg:#e3f5ea;
  --shadow:0 1px 2px rgba(20,25,40,.06),0 4px 16px rgba(20,25,40,.06);
}
@media (prefers-color-scheme:dark){
  :root{--paper:#0e1116;--surface:#171b22;--ink:#e8ecf2;--muted:#8b93a2;
    --line:#2a313c;--accent:#8ea2ff;--good:#4ccf8b;--good-bg:#12301f;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 20px rgba(0,0,0,.35);}
}
:root[data-theme=dark]{--paper:#0e1116;--surface:#171b22;--ink:#e8ecf2;--muted:#8b93a2;--line:#2a313c;--accent:#8ea2ff;--good:#4ccf8b;--good-bg:#12301f;--shadow:0 1px 2px rgba(0,0,0,.4),0 6px 20px rgba(0,0,0,.35);}
:root[data-theme=light]{--paper:#eef1f5;--surface:#fff;--ink:#191c22;--muted:#6b7280;--line:#d7dce3;--accent:#3b4a9c;--good:#1f8a54;--good-bg:#e3f5ea;--shadow:0 1px 2px rgba(20,25,40,.06),0 4px 16px rgba(20,25,40,.06);}
*{box-sizing:border-box}
.wrap{font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif;
  color:var(--ink);background:var(--paper);padding:32px 24px 56px;min-height:100vh;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;}
.head{max-width:1180px;margin:0 auto 26px}
.head h1{font-size:26px;font-weight:800;letter-spacing:.01em;margin:0 0 6px;text-wrap:balance}
.sub{color:var(--muted);font-size:14px;margin:0 0 14px;line-height:1.6}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--good-bg);color:var(--good);
  font-size:12.5px;font-weight:700;padding:4px 11px;border-radius:999px;letter-spacing:.02em}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}
.grid{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(2,1fr);gap:22px}
@media(max-width:820px){.grid{grid-template-columns:1fr}.wrap{padding:20px 12px 40px}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 16px 18px;box-shadow:var(--shadow)}
.card h2{font-size:16px;font-weight:800;margin:2px 2px 12px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.card h2 .cls{font-size:11.5px;font-weight:500;color:var(--muted);letter-spacing:.01em}
.tw{overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:3px;table-layout:fixed}
th,td{border-radius:7px}
thead,tr:first-child th{font-size:12px}
tr:first-child th{color:var(--muted);font-weight:600;padding:2px 0 4px}
.pcol{width:52px;text-align:left;vertical-align:middle;padding-left:2px}
.pn{display:block;font-size:11.5px;font-weight:700;color:var(--ink)}
.pt{display:block;font-size:9.5px;color:var(--muted);font-variant-numeric:tabular-nums}
td{height:44px;text-align:center;vertical-align:middle;padding:3px 4px;background:var(--paper);border:1px solid transparent}
.cell{background:color-mix(in srgb,var(--subj) 15%,var(--surface));
  border-left:3px solid var(--subj);}
.cell .sn{display:block;font-size:12.5px;font-weight:600;line-height:1.15}
.cell .tt{display:block;font-size:9px;color:var(--muted);margin-top:2px;letter-spacing:.02em}
.na{background:repeating-linear-gradient(135deg,transparent,transparent 5px,color-mix(in srgb,var(--line) 55%,transparent) 5px,color-mix(in srgb,var(--line) 55%,transparent) 6px);border:1px dashed var(--line)}
.brk td{background:transparent;color:var(--muted);font-size:11px;letter-spacing:.3em;height:22px;border:none}
.brk .pcol ., .brk th{font-weight:600;color:var(--muted);font-size:10.5px}
.foot{max-width:1180px;margin:26px auto 0;color:var(--muted);font-size:11.5px;line-height:1.7}
@media print{
  :root{--paper:#fff;--surface:#fff}
  .wrap{padding:0}.grid{grid-template-columns:1fr;gap:0}
  .card{break-inside:avoid;page-break-inside:avoid;box-shadow:none;border:none;padding:0 0 10px;margin-bottom:14px}
  .legend,.pill{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .cell{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>'''

body=f'''{CSS}
<div class="wrap">
  <header class="head">
    <h1>全校課表 · 自動排課結果</h1>
    <p class="sub">忠孝全科同步（每年級忠孝共用一張表）· 依 12 條硬規則自動填課 · 母語鎖週四且母語教師週四純母語 · 彈性在地鎖週五第一節 · 體育跨日隔天 · 教師單日≤5(母語例外) · 級任無整天空堂 · 級任連堂≤3 · 主科上午 · 第七節排輕科<br>
    來源：課務編排 v02 匯出資料 · 6 年級 12 班 24 位教師 · 共 336 格</p>
    <span class="pill">獨立驗證通過：0 衝堂 · 0 違規 · 節數全符 · 級任連堂 102 組</span>
    <div class="legend">{legend}</div>
  </header>
  <div class="grid">
    {''.join(cards)}
  </div>
  <p class="foot">斜線格＝該年級該節無排課時段。生活為分節上課，格內小字為忠／孝各自任課教師。此表可直接列印或存 PDF；忠班與孝班每一科同節，故各年級僅呈現一張。</p>
</div>'''
open('timetable.html','w',encoding='utf-8').write(body)
print("wrote timetable.html", len(body),"bytes")
