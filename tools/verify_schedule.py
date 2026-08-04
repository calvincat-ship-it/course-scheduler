# -*- coding: utf-8 -*-
"""獨立驗證 state_filled.json 是否符合全部硬規則 + 約束。不重用 solver 邏輯。"""
import os as _os; _os.chdir(_os.path.dirname(_os.path.abspath(__file__)) or ".")
import json, collections, sys
FN = sys.argv[1] if len(sys.argv)>1 else 'state_filled.json'
S = json.load(open(FN, encoding='utf-8'))
subs={s['id']:s for s in S['subjects']}; grades={g['id']:g for g in S['grades']}
classes={c['id']:c for c in S['classes']}; teachers={t['id']:t for t in S['teachers']}
NAME={i:subs[i]['name'] for i in subs}
SN={s['name']:s['id'] for s in S['subjects']}
PERIODS=[p['id'] for p in S['settings']['periods'] if not p['isBreak']]
DAYS=S['settings']['days']
gc=collections.defaultdict(list)
for c in S['classes']: gc[c['gradeId']].append(c['id'])
def cells_of(gid):
    g=grades[gid]; return [(d,p) for p in PERIODS for d in g['periodDays'].get(p,[])]
req_of=lambda gid:{sh['subjectId']:sh['hours'] for sh in grades[gid]['subjectHours']}
load_idx=collections.defaultdict(list)
for t in S['teachers']:
    for L in t['load']: load_idx[(L['classId'],L['subjectId'])].append((t['id'],L['hours'],L.get('roomId','')))
SPLIT={i for i in subs if subs[i].get('splitTeachers')}
slots=S['slots']; sT=S['slotTeachers']
errs=[]; warns=[]

# 0) 忠孝同步一致
for gid in grades:
    cs=gc[gid]
    for (d,p) in cells_of(gid):
        vals=[slots.get(f'{c}|{d}|{p}') for c in cs]
        if len(set(vals))!=1: errs.append(f'忠孝不同步 {grades[gid]["name"]} {d}{p}: {[NAME.get(v) for v in vals]}')

# 1) 每格填滿 + 每科節數
for gid in grades:
    for c in gc[gid]:
        cnt=collections.Counter()
        for (d,p) in cells_of(gid):
            v=slots.get(f'{c}|{d}|{p}')
            if v is None: errs.append(f'空格 {classes[c]["name"]} {d}{p}')
            else: cnt[v]+=1
        for sid,r in req_of(gid).items():
            if cnt[sid]!=r: errs.append(f'節數錯 {classes[c]["name"]} {NAME[sid]} 排{cnt[sid]}≠需{r}')
        extra=set(cnt)-set(req_of(gid))
        if extra: errs.append(f'多出科目 {classes[c]["name"]} {[NAME[e] for e in extra]}')

# 2) 老師衝堂 (grade,subject granularity；忠孝同科=同一協同節不算衝)
occ=collections.defaultdict(list)  # (tid,d,p)->[(gid,sid)]
for gid in grades:
    for sid,r in req_of(gid).items():
        placed=[(d,p) for (d,p) in cells_of(gid) if slots.get(f'{gc[gid][0]}|{d}|{p}')==sid]
        if sid in SPLIT:
            for c in gc[gid]:
                for (d,p) in cells_of(gid):
                    if slots.get(f'{c}|{d}|{p}')==sid:
                        tid=sT.get(f'{c}|{d}|{p}')
                        if not tid: errs.append(f'分節缺老師 {classes[c]["name"]} {d}{p}')
                        else: occ[(tid,d,p)].append((gid,sid,c))
        else:
            ts=set(t for t,_,_ in sum((load_idx.get((c,sid),[]) for c in gc[gid]),[]))
            for (d,p) in placed:
                for tid in ts: occ[(tid,d,p)].append((gid,sid,'grp'))
for (tid,d,p),lst in occ.items():
    sess=set((g,s) for g,s,_ in lst)
    if len(sess)>1:
        errs.append(f'教師衝堂 {teachers[tid]["name"]} {d}{p}: {[(grades[g]["name"],NAME[s]) for g,s in sess]}')

# 3) 教師不排課時段
for (tid,d,p),lst in occ.items():
    if f'{d}|{p}' in teachers[tid]['unavailable']:
        errs.append(f'排到不排課時段 {teachers[tid]["name"]} {d}{p}')

# 4) 教室衝堂 (grade,subject granularity)
roomocc=collections.defaultdict(list)
for gid in grades:
    for sid,r in req_of(gid).items():
        rs=set(rid for _,_,rid in sum((load_idx.get((c,sid),[]) for c in gc[gid]),[]) if rid)
        placed=[(d,p) for (d,p) in cells_of(gid) if slots.get(f'{gc[gid][0]}|{d}|{p}')==sid]
        for rid in rs:
            for (d,p) in placed: roomocc[(rid,d,p)].append((gid,sid))
for (rid,d,p),lst in roomocc.items():
    if len(set(lst))>1:
        rn=next(r['name'] for r in S['rooms'] if r['id']==rid)
        errs.append(f'教室衝堂 {rn} {d}{p}: {[(grades[g]["name"],NAME[s]) for g,s in set(lst)]}')

# ---- HARD RULES on placement (use grade rep class) ----
def sub_at(gid,d,p): return slots.get(f'{gc[gid][0]}|{d}|{p}')
def cells_by_sub(gid,sid): return [(d,p) for (d,p) in cells_of(gid) if sub_at(gid,d,p)==sid]
PIDX={p:i for i,p in enumerate(PERIODS)}
def adjacent(a,b):  # true time-adjacency (exclude lunch p4-p5)
    i,j=sorted((PIDX[a],PIDX[b]))
    return j-i==1 and not (PERIODS[i]=='p4')

# R2 體育
PE=SN['體育']
for gid in grades:
    for (d,p) in cells_by_sub(gid,PE):
        if p in('p1','p4','p5'): errs.append(f'[R2] {grades[gid]["name"]} 體育在{p} ({d})')
    byday=collections.defaultdict(list)
    for (d,p) in cells_by_sub(gid,PE): byday[d].append(p)
    for d,ps in byday.items():
        for a in ps:
            for b in ps:
                if a<b and adjacent(a,b): errs.append(f'[R2] {grades[gid]["name"]} 體育連堂 {d} {a}{b}')

# R4 母語
NAT=SN['母語課程']
for gid in grades:
    for (d,p) in cells_by_sub(gid,NAT):
        if not(d==4 and p in('p1','p2','p3','p5','p6','p7')): errs.append(f'[R4] {grades[gid]["name"]} 母語在 {d}{p} 非法')

# R5 no p2-p3 連堂 any subject
for gid in grades:
    for c in gc[gid]:
        for d in DAYS:
            a=slots.get(f'{c}|{d}|p2'); b=slots.get(f'{c}|{d}|p3')
            if a and a==b: errs.append(f'[R5] {classes[c]["name"]} {d} p2p3連堂 {NAME[a]}')

def count_valid_doubles(gid,sid):
    byday=collections.defaultdict(set)
    for (d,p) in cells_by_sub(gid,sid): byday[d].add(p)
    n=0; runs=[]
    for d,ps in byday.items():
        idxs=sorted(PIDX[p] for p in ps)
        # count adjacency pairs excluding lunch & p2-p3
        for i in range(len(idxs)-1):
            if idxs[i+1]-idxs[i]==1:
                a,b=PERIODS[idxs[i]],PERIODS[idxs[i+1]]
                if adjacent(a,b) and not(a=='p2' and b=='p3'): n+=1
    return n
def count_any_adjacency(gid,sid):
    byday=collections.defaultdict(set)
    for (d,p) in cells_by_sub(gid,sid): byday[d].add(p)
    n=0
    for d,ps in byday.items():
        idxs=sorted(PIDX[p] for p in ps)
        for i in range(len(idxs)-1):
            if idxs[i+1]-idxs[i]==1 and adjacent(PERIODS[idxs[i]],PERIODS[idxs[i+1]]): n+=1
    return n

# R3 社會/自然 =1連堂+1獨立
for gid in grades:
    for nm in ('社會','自然'):
        sid=SN[nm]
        if sid not in req_of(gid): continue
        vd=count_valid_doubles(gid,sid); anyadj=count_any_adjacency(gid,sid)
        if not(vd==1 and anyadj==1):
            errs.append(f'[R3] {grades[gid]["name"]} {nm} 連堂結構不符 (validDbl={vd}, anyAdj={anyadj})')

# R6 國語>=1連堂
CH=SN['國語']
for gid in grades:
    if count_valid_doubles(gid,CH)<1: errs.append(f'[R6] {grades[gid]["name"]} 國語無連堂')
# R7 美勞連堂
AR=SN['美勞']
for gid in grades:
    if AR in req_of(gid):
        if count_valid_doubles(gid,AR)!=1 or count_any_adjacency(gid,AR)!=1:
            errs.append(f'[R7] {grades[gid]["name"]} 美勞連堂不符')
# R1 第七節 light
LIGHT={SN['體育'],SN['綜合'],SN['美勞'],SN['音樂'],SN['生活']}
for gid in grades:
    p7=[(d,'p7') for (d,p) in cells_of(gid) if p=='p7']
    if not p7: continue
    K=1 if grades[gid]['name'] in('一年級','二年級') else 2
    lit=sum(1 for (d,p) in p7 if sub_at(gid,d,p) in LIGHT)
    if lit<K: errs.append(f'[R1] {grades[gid]["name"]} 第七節light={lit}<{K}')

# split hour counts
for gid in grades:
    for c in gc[gid]:
        want={t:h for t,h,_ in load_idx.get((c,SN['生活']),[])}
        if not want: continue
        got=collections.Counter()
        for (d,p) in cells_of(gid):
            if slots.get(f'{c}|{d}|{p}')==SN['生活']:
                got[sT.get(f'{c}|{d}|{p}')]+=1
        for t,h in want.items():
            if got[t]!=h: errs.append(f'[分節] {classes[c]["name"]} {teachers[t]["name"]} 生活{got[t]}≠{h}')

# ===== NEW RULES R8/R9/R10 =====
# R8 體育 兩節不同日且間隔>=2天(不得同日、不得相鄰兩天)
for gid in grades:
    days_pe=sorted(d for (d,p) in cells_by_sub(gid,PE))
    if len(days_pe)!=len(set(days_pe)):
        errs.append(f'[R8] {grades[gid]["name"]} 體育同日兩節 {days_pe}')
    ds=sorted(set(days_pe))
    for i in range(len(ds)-1):
        if ds[i+1]-ds[i]<2:
            errs.append(f'[R8] {grades[gid]["name"]} 體育兩日間隔不足 {ds}')
# R9 彈性在地 全鎖 週五 p1
LOC=SN['彈性在地']
for gid in grades:
    if LOC not in req_of(gid): continue
    for (d,p) in cells_by_sub(gid,LOC):
        if not (d==5 and p=='p1'):
            errs.append(f'[R9] {grades[gid]["name"]} 彈性在地在 {d}{p} 非週五p1')
# R10 教師單日<=5(非母語) ; 另報含母語最大值
NATID=SN['母語課程']
perday=collections.defaultdict(lambda: collections.defaultdict(int))      # (tid)-> day-> count(all)
perday_nn=collections.defaultdict(lambda: collections.defaultdict(int))   # 非母語
for (tid,d,p),lst in occ.items():
    sess=set((g,s) for g,s,_ in lst)
    for (g,s) in sess:
        perday[tid][d]+=1
        if s!=NATID: perday_nn[tid][d]+=1
for tid,dd in perday_nn.items():
    for d,c in dd.items():
        if c>5: errs.append(f'[R10] {teachers[tid]["name"]} {d} 非母語 {c} 節 >5')
maxall=max((c for dd in perday.values() for c in dd.values()), default=0)
# P3 級任連堂統計
home=[t['id'] for t in S['teachers'] if t['type']=='級任']
PIDX2={p:i for i,p in enumerate(PERIODS)}
def adj2(a,b):
    i,j=sorted((PIDX2[a],PIDX2[b])); return j-i==1 and PERIODS[i]!='p4'
home_pairs=0; home_busy=collections.defaultdict(set)
for (tid,d,p),lst in occ.items():
    if tid in home and lst: home_busy[(tid,d)].add(p)
for (tid,d),ps in home_busy.items():
    for a in ps:
        for b in ps:
            if a<b and adj2(a,b): home_pairs+=1

# R12 母語教師週四不得排非母語課
NATT={tid for (cid,sid),lst in load_idx.items() if sid==NATID for tid,_,_ in lst}
for tid in NATT:
    nn=perday_nn[tid].get(4,0)
    if nn>0: errs.append(f'[R12] {teachers[tid]["name"]} 週四排了 {nn} 節非母語課')
# R11 級任每個非全阻擋日至少1節
for t in S['teachers']:
    if t['type']!='級任': continue
    tid=t['id']; un=set(t['unavailable'])
    for d in DAYS:
        blocked=all(f'{d}|{p}' in un for p in PERIODS)
        if not blocked and perday[tid].get(d,0)<1:
            errs.append(f'[R11] {t["name"]} 週{d} 整天空堂(該日非全阻擋)')
# P3上限 級任連堂<=3 (禁上午p1-p4連4) — 由 slots 重建實際任課節
for t in S['teachers']:
    if t['type']!='級任': continue
    tid=t['id']
    for d in DAYS:
        bset=set()
        for gid in grades:
            for sid in req_of(gid):
                if sid in SPLIT: continue
                ts=set(x for x,_,_ in sum((load_idx.get((c,sid),[]) for c in gc[gid]),[]))
                if tid in ts:
                    for p in PERIODS:
                        if sub_at(gid,d,p)==sid: bset.add(p)
        # split生活 by slotTeachers
        for gid in grades:
            for c in gc[gid]:
                for p in PERIODS:
                    if sT.get(f'{c}|{d}|{p}')==tid: bset.add(p)
        run=0
        for p in PERIODS:
            if p=='p5': run=0  # lunch breaks the run
            if p in bset: run+=1
            else: run=0
            if run>3: errs.append(f'[P3上限] {t["name"]} 週{d} 連堂>3 ({p})')

print("="*50)
print(f"驗證檔: {FN}")
print(f"錯誤 {len(errs)} 項, 警告 {len(warns)} 項")
for e in errs[:60]: print("  ✗",e)
if not errs: print("  ✅ 全部硬規則與約束通過")
# preference stats
ch_p1=sum(1 for gid in grades for d in DAYS if sub_at(gid,d,'p1')==CH)
main_pm=sum(1 for gid in grades for (d,p) in cells_of(gid) if p in('p5','p6','p7') and sub_at(gid,d,p) in (CH,SN['數學']))
print(f"偏好: 國語在第一節 {ch_p1} 格(共30可能) ; 主科(國/數)排到下午 {main_pm} 格")
print(f"R10: 教師單日最多節數(含母語)={maxall} ; 非母語一律<=5 已檢查")
print(f"P3: 級任老師相鄰兩節連堂 共 {home_pairs} 組")
