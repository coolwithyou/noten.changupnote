#!/usr/bin/env python3
"""
K-Startup 엔드투엔드 매칭 데모 (설계 검증용)
공고(실데이터) → grant_criteria 파싱 → 가상 사업자 프로필과 매칭
→ 적격/조건부/부적격 + rule_trace + 적합도 점수.
키: 환경변수 KSTARTUP_SERVICE_KEY (커밋 금지)
"""
import os, json, re, urllib.request, datetime
from collections import Counter

KEY=os.environ["KSTARTUP_SERVICE_KEY"]
BASE="https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation"
TODAY=datetime.date.today()
REGION={'서울':'11','부산':'26','대구':'27','인천':'28','광주':'29','대전':'30','울산':'31','세종':'36',
        '경기':'41','강원':'42','충북':'43','충남':'44','전북':'45','전남':'46','경북':'47','경남':'48','제주':'50'}
METRO={'11','28','41'}  # 수도권

# ---- 가상 사업자 (교체 가능) ----
COMPANY={'name':'(가칭)테크스타트','region':'41','region_nm':'경기',
         'biz_age_months':26,'founder_age':35,'is_preliminary':False,'industry':['ICT','SW'],'size':'중소'}

def fetch(pages=5,per=100):
    rows=[]
    for p in range(1,pages+1):
        with urllib.request.urlopen(f"{BASE}?serviceKey={KEY}&page={p}&perPage={per}&returnType=json",timeout=30) as r:
            rows+=json.load(r)['data']
    return rows
def isopen(r):
    e=r.get('pbanc_rcpt_end_dt') or ''
    return len(e)==8 and datetime.date(int(e[:4]),int(e[4:6]),int(e[6:]))>=TODAY
def enyy(v):
    toks=[t.strip() for t in (v or '').split(',') if t.strip()]
    yrs=[int(m.group(1)) for t in toks if (m:=re.match(r'(\d+)년미만',t))]
    return (max(yrs)*12 if yrs else None), ('예비창업자' in toks)
def age_ok(v,age):
    toks=[t.strip() for t in (v or '').split(',') if t.strip()]
    if set(toks)>={'만 20세 미만','만 20세 이상 ~ 만 39세 이하','만 40세 이상'} or not toks: return True
    if age<20: return '만 20세 미만' in toks
    if age<=39: return '만 20세 이상 ~ 만 39세 이하' in toks
    return '만 40세 이상' in toks

def match(r,c):
    trace=[]; elig='eligible'
    excl=r.get('aply_excl_trgt_ctnt') or ''
    if '수도권' in excl and '제외' in excl and c['region'] in METRO:
        trace.append(('지역','exclusion','fail',f"수도권 제외 — {c['region_nm']} 해당")); elig='ineligible'
    reg=(r.get('supt_regin') or '').strip()
    if reg and reg!='전국':
        ok=REGION.get(reg)==c['region']; trace.append(('지역','required','pass' if ok else 'fail',f"{reg} 대상 — 귀사 {c['region_nm']}"))
        if not ok: elig='ineligible'
    else: trace.append(('지역','required','pass','전국'))
    mx,prelim=enyy(r.get('biz_enyy'))
    if mx is not None:
        ok=(c['biz_age_months']<=mx) or (prelim and c['is_preliminary'])
        trace.append(('업력','required','pass' if ok else 'fail',f"{mx//12}년 이내{'·예비' if prelim else ''} — 귀사 {c['biz_age_months']//12}년 {c['biz_age_months']%12}개월"))
        if not ok and elig!='ineligible': elig='ineligible'
    ok=age_ok(r.get('biz_trgt_age'),c['founder_age']); trace.append(('연령','required','pass' if ok else 'fail',f"대표 {c['founder_age']}세"))
    if not ok and elig!='ineligible': elig='ineligible'
    if re.search(r'중소기업|중견|소상공인|매출|제조|업종|분야|소재|부품',(r.get('aply_trgt_ctnt') or '')) and elig=='eligible':
        trace.append(('업종/규모','required(text)','unknown','원문 확인(구조화 미추출)')); elig='conditional'
    score={'ineligible':0,'conditional':70,'eligible':100}[elig]
    return elig,score,trace

if __name__=="__main__":
    opens=[r for r in fetch() if isopen(r)]
    res=[(match(r,COMPANY),r) for r in opens]
    cnt=Counter(e for (e,_,_),_ in res)
    print(f"open {len(opens)}건 / 적격 {cnt['eligible']} 조건부 {cnt['conditional']} 부적격 {cnt['ineligible']}")
    for (e,s,t),r in sorted(res,key=lambda x:-x[0][1])[:6]:
        print(f"\n[{e} {s}] {r['biz_pbanc_nm'][:46]} (~{r['pbanc_rcpt_end_dt']})")
        for d,k,res2,m in t:
            print(f"   {{'pass':'✅','fail':'❌','unknown':'⚠'}}[res2] {d}: {m}".replace("{'pass':'✅','fail':'❌','unknown':'⚠'}[res2]",{'pass':'✅','fail':'❌','unknown':'⚠'}[res2]))
