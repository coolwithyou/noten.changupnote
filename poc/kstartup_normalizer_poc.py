#!/usr/bin/env python3
"""
K-Startup 공고 → grant_criteria 정규화 PoC (S0-A / S0-C 구조화 파트)
- 목적: 구조화 필드만으로 자격요건 criteria가 몇 % 자동 산출되는지 + LLM 잔여 필요 추정.
- 키: 환경변수 KSTARTUP_SERVICE_KEY (절대 하드코딩/커밋 금지)
실행:  KSTARTUP_SERVICE_KEY=... python3 kstartup_normalizer_poc.py
"""
import os, json, re, urllib.request, datetime
from collections import Counter

KEY = os.environ["KSTARTUP_SERVICE_KEY"]
BASE = "https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation"
TODAY = datetime.date.today()

REGION = {'서울':'11','부산':'26','대구':'27','인천':'28','광주':'29','대전':'30','울산':'31','세종':'36',
          '경기':'41','강원':'42','충북':'43','충남':'44','전북':'45','전남':'46','경북':'47','경남':'48','제주':'50'}

def fetch(pages=5, per=100):
    rows=[]
    for p in range(1, pages+1):
        url=f"{BASE}?serviceKey={KEY}&page={p}&perPage={per}&returnType=json"
        with urllib.request.urlopen(url, timeout=30) as r:
            d=json.load(r)
        rows += d['data']
    return rows, d['totalCount']

# ---- 파서 (구조화 필드 → canonical) ----
def parse_enyy(v):
    toks=[t.strip() for t in (v or '').split(',') if t.strip()]
    yrs=[int(m.group(1)) for t in toks if (m:=re.match(r'(\d+)년미만', t))]
    return {'max_months': max(yrs)*12 if yrs else None, 'include_preliminary': '예비창업자' in toks}

def parse_age(v):
    toks=[t.strip() for t in (v or '').split(',') if t.strip()]
    full={'만 20세 미만','만 20세 이상 ~ 만 39세 이하','만 40세 이상'}
    if set(toks) >= full: return None            # 전연령 = 제약 없음
    youth = ('만 40세 이상' not in toks) and ('만 20세 이상 ~ 만 39세 이하' in toks)
    return {'age_brackets': toks, 'youth_only': youth}

def parse_region(v):
    v=(v or '').strip()
    if v in ('', '전국'): return {'regions': [], 'nationwide': True}
    return {'regions': [REGION.get(v, v)], 'nationwide': False}

def status(r):
    e=r.get('pbanc_rcpt_end_dt') or ''
    if len(e)==8:
        d=datetime.date(int(e[:4]), int(e[4:6]), int(e[6:]))
        return 'open' if d>=TODAY else 'closed'
    return 'unknown'

def to_criteria(r):
    crit=[]
    rg=parse_region(r['supt_regin'])
    if not rg['nationwide']:
        crit.append({'dim':'region','op':'in','val':rg,'kind':'required','src':'supt_regin'})
    crit.append({'dim':'biz_age','op':'lte','val':parse_enyy(r['biz_enyy']),'kind':'required','src':'biz_enyy'})
    ag=parse_age(r['biz_trgt_age'])
    if ag: crit.append({'dim':'founder_age','op':'in','val':ag,'kind':'required','src':'biz_trgt_age'})
    # NOTE: 업종·규모·인증·지역배제는 aply_trgt_ctnt / aply_excl_trgt_ctnt 의 LLM 추출 필요(잔여)
    return crit

# ---- 잔여 LLM 필요 추정 (휴리스틱) ----
RX={'size':re.compile(r'중소기업|중견|소상공인|상시근로자|매출'),
    'industry':re.compile(r'제조|업종|분야|소재|부품|장비|바이오|콘텐츠|ICT|소프트웨어|SW|딥테크|로봇'),
    'cert':re.compile(r'벤처기업|이노비즈|메인비즈|연구소|전담부서|특허'),
    'region_excl':re.compile(r'수도권|제외')}

if __name__=="__main__":
    rows, total = fetch()
    N=len(rows)
    print(f"표본 {N} / total {total}")
    fields=['supt_regin','biz_enyy','biz_trgt_age','supt_biz_clsfc','aply_trgt','aply_trgt_ctnt','pbanc_rcpt_end_dt','aply_excl_trgt_ctnt']
    print("\n[구조화 커버리지]")
    for f in fields:
        c=sum(1 for r in rows if r.get(f) not in (None,''))
        print(f"  {f:22} {c/N*100:5.1f}%")
    cnt=Counter();
    for r in rows:
        t=(r.get('aply_trgt_ctnt') or '')+' '+(r.get('aply_excl_trgt_ctnt') or '')
        for k,rx in RX.items():
            if rx.search(t): cnt[k]+=1
    print("\n[scoped 텍스트 LLM 잔여 필요 추정]")
    for k in RX: print(f"  {k:12} {cnt[k]/N*100:5.1f}%")
    print(f"\n현재 open: {sum(1 for r in rows if status(r)=='open')}/{N}")
    print("\n[샘플 criteria]")
    for r in rows[:3]:
        print(f"\n{r['biz_pbanc_nm'][:40]} (분야={r['supt_biz_clsfc']}, {status(r)})")
        for c in to_criteria(r): print("  ", c)
