# -*- coding: utf-8 -*-
"""課務編排自動填課 v2 — 加 R8體育跨日隔天 / R9彈性在地鎖週五p1 / R10教師單日<=5 / P3級任連堂"""
import os as _os; _os.chdir(_os.path.dirname(_os.path.abspath(__file__)) or ".")
import json, sys, collections
from ortools.sat.python import cp_model
S=json.load(open('state.json',encoding='utf-8'))
subs={s['id']:s for s in S['subjects']}; grades={g['id']:g for g in S['grades']}
classes={c['id']:c for c in S['classes']}; teachers={t['id']:t for t in S['teachers']}
sid_by_name={s['name']:s['id'] for s in S['subjects']}; SN=lambda n:sid_by_name[n]
PERIODS=[p['id'] for p in S['settings']['periods'] if not p['isBreak']]; PIDX={p:i for i,p in enumerate(PERIODS)}
DAYS=S['settings']['days']
gc=collections.defaultdict(list)
for c in S['classes']: gc[c['gradeId']].append(c['id'])
def cells_of(gid):
    g=grades[gid]; return [(d,p) for p in PERIODS for d in g['periodDays'].get(p,[])]
def req_of(gid): return {sh['subjectId']:sh['hours'] for sh in grades[gid]['subjectHours']}
load_idx=collections.defaultdict(list)
for t in S['teachers']:
    for L in t['load']: load_idx[(L['classId'],L['subjectId'])].append((t['id'],L['hours'],L.get('roomId','')))
def teachers_rooms(gid,sid):
    ts=set(); rs=set()
    for cid in gc[gid]:
        for tid,h,rid in load_idx.get((cid,sid),[]):
            ts.add(tid)
            if rid: rs.add(rid)
    return ts,rs
SPLIT={i for i in subs if subs[i].get('splitTeachers')}
PE=SN('體育'); NAT=SN('自然'); SOC=SN('社會'); ART=SN('美勞'); MUS=SN('音樂')
INTG=SN('綜合'); LIFE=SN('生活'); CHIN=SN('國語'); MATH=SN('數學'); NATIVE=SN('母語課程')
LOCAL=SN('彈性在地')
LIGHT={PE,INTG,ART,MUS,LIFE}
REAL_ADJ=[(PERIODS[i],PERIODS[i+1]) for i in range(len(PERIODS)-1) if not (PERIODS[i]=='p4' and PERIODS[i+1]=='p5')]
VALID_DBL=[(a,b) for (a,b) in REAL_ADJ if not (a=='p2' and b=='p3')]

m=cp_model.CpModel(); X={}
for gid in grades:
    req=req_of(gid)
    for sid,r in req.items():
        ts,rs=teachers_rooms(gid,sid); unavail=set()
        if sid not in SPLIT:
            for tid in ts:
                for u in teachers[tid]['unavailable']:
                    d,p=u.split('|'); unavail.add((int(d),p))
        for (d,p) in cells_of(gid):
            v=m.NewBoolVar(f'x_{gid}_{sid}_{d}_{p}'); X[(gid,sid,d,p)]=v
            if sid not in SPLIT and (d,p) in unavail: m.Add(v==0)
# C1/C2
for gid in grades:
    for (d,p) in cells_of(gid):
        m.Add(sum(X[(gid,sid,d,p)] for sid in req_of(gid))==1)
    for sid,r in req_of(gid).items():
        m.Add(sum(X[(gid,sid,d,p)] for (d,p) in cells_of(gid))==r)
# split生活
ST={}; split_info={}
for gid in grades:
    if LIFE not in req_of(gid): continue
    zc,xc=gc[gid][0],gc[gid][1]
    if '孝' in classes[zc]['name']: zc,xc=xc,zc
    st=lambda cid:[(tid,h) for tid,h,rid in load_idx.get((cid,LIFE),[])]
    split_info[gid]={'z':st(zc),'x':st(xc),'zc':zc,'xc':xc}
    for side,cid in (('z',zc),('x',xc)):
        for tid,h in split_info[gid][side]:
            un=set()
            for u in teachers[tid]['unavailable']:
                d,p=u.split('|'); un.add((int(d),p))
            for (d,p) in cells_of(gid):
                b=m.NewBoolVar(f'st_{gid}_{side}_{tid}_{d}_{p}'); ST[(gid,side,tid,d,p)]=b
                if (d,p) in un: m.Add(b==0)
    for side in ('z','x'):
        tids=[tid for tid,h in split_info[gid][side]]
        for (d,p) in cells_of(gid):
            m.Add(sum(ST[(gid,side,tid,d,p)] for tid in tids)==X[(gid,LIFE,d,p)])
        for tid,h in split_info[gid][side]:
            m.Add(sum(ST[(gid,side,tid,d,p)] for (d,p) in cells_of(gid))==h)
# teacher occupancy
occ=collections.defaultdict(list)
occ_r10=collections.defaultdict(list)  # 排除母語(週四集中,結構性例外)
for gid in grades:
    for sid,r in req_of(gid).items():
        if sid in SPLIT: continue
        ts,_=teachers_rooms(gid,sid)
        for tid in ts:
            for (d,p) in cells_of(gid):
                if (gid,sid,d,p) in X:
                    occ[(tid,d,p)].append(X[(gid,sid,d,p)])
                    if sid!=NATIVE: occ_r10[(tid,d,p)].append(X[(gid,sid,d,p)])
for (gid,side,tid,d,p),b in ST.items():
    occ[(tid,d,p)].append(b); occ_r10[(tid,d,p)].append(b)
for (tid,d,p),vs in occ.items():
    if len(vs)>1: m.Add(sum(vs)<=1)
# room
roomocc=collections.defaultdict(list)
for gid in grades:
    for sid,r in req_of(gid).items():
        _,rs=teachers_rooms(gid,sid)
        for rid in rs:
            for (d,p) in cells_of(gid):
                if (gid,sid,d,p) in X: roomocc[(rid,d,p)].append(X[(gid,sid,d,p)])
for (rid,d,p),vs in roomocc.items():
    if len(vs)>1: m.Add(sum(vs)<=1)
# double helper
def dbl(gid,sid,d,a,b):
    if (gid,sid,d,a) not in X or (gid,sid,d,b) not in X: return None
    v=m.NewBoolVar(f'dbl_{gid}_{sid}_{d}_{a}_{b}')
    m.AddBoolAnd([X[(gid,sid,d,a)],X[(gid,sid,d,b)]]).OnlyEnforceIf(v)
    m.AddBoolOr([X[(gid,sid,d,a)].Not(),X[(gid,sid,d,b)].Not()]).OnlyEnforceIf(v.Not())
    return v
# R5
for gid in grades:
    for sid in req_of(gid):
        for d in DAYS:
            if (gid,sid,d,'p2') in X and (gid,sid,d,'p3') in X:
                m.Add(X[(gid,sid,d,'p2')]+X[(gid,sid,d,'p3')]<=1)
# R2+R8 體育: 不排p1/p4/p5 ; 每日<=1 ; 相鄰兩天不得都排(=>間隔>=2天，含不同日)
for gid in grades:
    if PE not in req_of(gid): continue
    for (d,p) in cells_of(gid):
        if p in ('p1','p4','p5') and (gid,PE,d,p) in X: m.Add(X[(gid,PE,d,p)]==0)
    peday={}
    for d in DAYS:
        ps=[X[(gid,PE,d,p)] for p in PERIODS if (gid,PE,d,p) in X]
        if ps:
            m.Add(sum(ps)<=1); peday[d]=sum(ps)
    sd=sorted(peday)
    for i in range(len(sd)-1):
        if sd[i+1]-sd[i]==1:  # adjacent days
            m.Add(peday[sd[i]]+peday[sd[i+1]]<=1)
# R9 彈性在地鎖週五(5) p1
for gid in grades:
    if LOCAL in req_of(gid) and (gid,LOCAL,5,'p1') in X:
        m.Add(X[(gid,LOCAL,5,'p1')]==1)
# R4 母語
for gid in grades:
    if NATIVE not in req_of(gid): continue
    for (d,p) in cells_of(gid):
        if not (d==4 and p in ('p1','p2','p3','p5','p6','p7')) and (gid,NATIVE,d,p) in X:
            m.Add(X[(gid,NATIVE,d,p)]==0)
# R3 社會/自然
for gid in grades:
    for sid in (SOC,NAT):
        if sid not in req_of(gid): continue
        ds=[dbl(gid,sid,d,a,b) for d in DAYS for (a,b) in VALID_DBL]
        ds=[v for v in ds if v is not None]
        if ds: m.Add(sum(ds)==1)
# R7 美勞 / R6 國語
for gid in grades:
    if ART in req_of(gid):
        ds=[v for v in (dbl(gid,ART,d,a,b) for d in DAYS for (a,b) in VALID_DBL) if v is not None]
        if ds: m.Add(sum(ds)==1)
    ds=[v for v in (dbl(gid,CHIN,d,a,b) for d in DAYS for (a,b) in VALID_DBL) if v is not None]
    if ds: m.Add(sum(ds)>=1)
# R1 第七節 light
LOWG={gid for gid in grades if grades[gid]['name'] in ('一年級','二年級')}
for gid in grades:
    p7=[(d,'p7') for (d,p) in cells_of(gid) if p=='p7']
    if not p7: continue
    K=1 if gid in LOWG else 2
    terms=[X[(gid,sid,d,p)] for (d,p) in p7 for sid in LIGHT if (gid,sid,d,p) in X]
    m.Add(sum(terms)>=K)
# R1加嚴: 第七節非輕科者必須是級任的課(全部任課教師皆級任);否則禁排
def is_home(gid,sid):
    ts,_=teachers_rooms(gid,sid)
    return len(ts)>0 and all(teachers[t]['type']=='級任' for t in ts)
for gid in grades:
    for (d,p) in cells_of(gid):
        if p!='p7': continue
        for sid in req_of(gid):
            if sid in LIGHT or sid==NATIVE: continue  # 母語鎖週四,結構性豁免(同R10)
            if not is_home(gid,sid) and (gid,sid,d,p) in X:
                m.Add(X[(gid,sid,d,p)]==0)
# R10 教師單日<=5 節 (母語/週四集中為結構性例外,不計入)
byTD=collections.defaultdict(list)
for (tid,d,p),vs in occ_r10.items(): byTD[(tid,d)].extend(vs)
for (tid,d),vs in byTD.items():
    m.Add(sum(vs)<=5)
# busyBool for 級任 (P3)
HOME=[t['id'] for t in S['teachers'] if t['type']=='級任']
busy={}
for tid in HOME:
    for d in DAYS:
        for p in PERIODS:
            vs=occ.get((tid,d,p),[])
            if not vs: continue
            b=m.NewBoolVar(f'busy_{tid}_{d}_{p}'); m.Add(sum(vs)==b); busy[(tid,d,p)]=b
# R12 母語教師在母語重疊日(週四)不得排其他課(非母語占用=0)
NATIVE_TEACHERS={tid for (cid,sid),lst in load_idx.items() if sid==NATIVE for tid,_,_ in lst}
for tid in NATIVE_TEACHERS:
    vs=[v for p in PERIODS for v in occ_r10.get((tid,4,p),[])]
    if vs: m.Add(sum(vs)==0)
# R11加嚴: 級任每天「上午、下午各至少1節」(該半天無可排格則例外)
MORN=('p1','p2','p3','p4'); AFT=('p5','p6','p7')
for tid in HOME:
    for d in DAYS:
        for half in (MORN,AFT):
            vs=[v for p in half for v in occ.get((tid,d,p),[])]
            if vs: m.Add(sum(vs)>=1)
# P3硬上限: 級任連堂每區塊<=3 (唯一可能的4連=上午p1-p4,故禁全上午4連)
MORNING=['p1','p2','p3','p4']
for tid in HOME:
    for d in DAYS:
        mv=[busy[(tid,d,p)] for p in MORNING if (tid,d,p) in busy]
        if len(mv)==4: m.Add(sum(mv)<=3)
# ---- objective ----
obj=[]
for gid in grades:  # P1 國語第一節
    for d in DAYS:
        if (gid,CHIN,d,'p1') in X: obj.append(3*X[(gid,CHIN,d,'p1')])
for gid in grades:  # P2 主科不下午
    for sid in (CHIN,MATH):
        for (d,p) in cells_of(gid):
            if p in ('p5','p6','p7') and (gid,sid,d,p) in X: obj.append(-2*X[(gid,sid,d,p)])
# P3 級任連堂: 相鄰時段(同日,排除午休)兩節同一級任 -> reward
for tid in HOME:
    for d in DAYS:
        for (a,b) in REAL_ADJ:
            if (tid,d,a) in busy and (tid,d,b) in busy:
                pr=m.NewBoolVar(f'pr_{tid}_{d}_{a}_{b}')
                m.AddBoolAnd([busy[(tid,d,a)],busy[(tid,d,b)]]).OnlyEnforceIf(pr)
                m.AddBoolOr([busy[(tid,d,a)].Not(),busy[(tid,d,b)].Not()]).OnlyEnforceIf(pr.Not())
                obj.append(2*pr)
# P4 每位教師(母語除外)每日排課數平衡：最小化「整天(週一二四五)」之間的離散(max-min)。
#   週三全校下午為教學研究(半天,結構性較輕)，不納入平衡比較。
BAL_W=6
FULLDAYS=[d for d in DAYS if d!=3]
for t in S['teachers']:
    tid=t['id']
    if tid in NATIVE_TEACHERS: continue
    un=set(t['unavailable'])
    # 級任整天都跟自己班,週三(半天)也納入平衡;科任/兼行政因高授課,週三結構性較輕故排除
    bal_days=DAYS if t['type']=='級任' else FULLDAYS
    fdays=[d for d in bal_days if any(f'{d}|{p}' not in un for p in PERIODS)]
    if len(fdays)<2: continue
    dcs=[]
    for d in fdays:
        vs=[v for p in PERIODS for v in occ.get((tid,d,p),[])]
        if vs: dcs.append(sum(vs))
    if len(dcs)<2: continue
    mx=m.NewIntVar(0,7,f'bmx_{tid}'); mn=m.NewIntVar(0,7,f'bmn_{tid}')
    for s in dcs: m.Add(mx>=s); m.Add(mn<=s)
    obj.append(-BAL_W*(mx-mn))
# P5 所有教師上午(p1-p4)儘量不要 4 節滿堂
W5=8
for t in S['teachers']:
    tid=t['id']
    for d in DAYS:
        morn=[occ.get((tid,d,p),[]) for p in ('p1','p2','p3','p4')]
        if any(len(x)==0 for x in morn): continue   # 某上午節此師不可能排到 -> 不可能滿堂
        allv=[v for x in morn for v in x]
        f4=m.NewBoolVar(f'f4_{tid}_{d}')
        m.Add(sum(allv) <= 3 + f4)
        obj.append(-W5*f4)
m.Maximize(sum(obj))
solver=cp_model.CpSolver()
solver.parameters.max_time_in_seconds=float(sys.argv[1]) if len(sys.argv)>1 else 90.0
solver.parameters.num_search_workers=8
res=solver.Solve(m)
print("STATUS:",solver.StatusName(res),"obj=",solver.ObjectiveValue() if res in (cp_model.OPTIMAL,cp_model.FEASIBLE) else None)
if res in (cp_model.OPTIMAL,cp_model.FEASIBLE):
    slots={}; slotTeachers={}
    for gid in grades:
        for cid in gc[gid]:
            for sid,r in req_of(gid).items():
                for (d,p) in cells_of(gid):
                    if (gid,sid,d,p) in X and solver.Value(X[(gid,sid,d,p)]): slots[f'{cid}|{d}|{p}']=sid
        if gid in split_info:
            for side,cid in (('z',split_info[gid]['zc']),('x',split_info[gid]['xc'])):
                for tid,h in split_info[gid][side]:
                    for (d,p) in cells_of(gid):
                        if (gid,side,tid,d,p) in ST and solver.Value(ST[(gid,side,tid,d,p)]): slotTeachers[f'{cid}|{d}|{p}']=tid
    out=dict(S); out['slots']=slots; out['slotTeachers']=slotTeachers
    json.dump(out,open('state_filled.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
    print("WROTE state_filled.json slots=",len(slots),"slotTeachers=",len(slotTeachers))
else:
    print("NO SOLUTION — 需放寬某條規則")
