#!/usr/bin/env python3
"""
S0-F 신청양식 구조 스파이크 (K-Startup)
- 질문: 정부지원사업은 *주로 어떻게* 신청하나? 신청방식 분포 + 자동완성/초안 함의.
- 보너스(S0-G 타진): aply_excl_trgt_ctnt에 '과거 선정기업 제외'(prior_award) 언급이 얼마나 흔한가?
- 키: 환경변수 KSTARTUP_SERVICE_KEY (하드코딩/커밋 금지)
실행: KSTARTUP_SERVICE_KEY=... python3 poc/s0f_application_probe.py
"""
import os, json, re, urllib.request, datetime
from collections import Counter

KEY = os.environ["KSTARTUP_SERVICE_KEY"]
BASE = "https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation"
TODAY = datetime.date.today()

MTHD = {  # 신청방법 필드 → 한글
    'aply_mthd_onli_rcpt_istc': '온라인',
    'aply_mthd_eml_rcpt_istc': '이메일',
    'aply_mthd_fax_rcpt_istc': '팩스',
    'aply_mthd_pssr_rcpt_istc': '우편',
    'aply_mthd_vst_rcpt_istc': '방문',
    'aply_mthd_etc_istc': '기타',
}

def fetch(pages, per=100):
    rows = []
    total = None
    for p in range(1, pages + 1):
        url = f"{BASE}?serviceKey={KEY}&page={p}&perPage={per}&returnType=json"
        with urllib.request.urlopen(url, timeout=30) as r:
            d = json.load(r)
        rows += d['data']
        total = d.get('totalCount', total)
        if len(d['data']) < per:
            break
    return rows, total

def is_open(r):
    e = r.get('pbanc_rcpt_end_dt') or ''
    if len(e) == 8:
        try:
            return datetime.date(int(e[:4]), int(e[4:6]), int(e[6:])) >= TODAY
        except ValueError:
            return False
    return False

# 과거 수혜/중복지원 배제 언급 (prior_award exclusion 신호)
PRIOR = re.compile(r'선정기업|선정된|기\s*선정|기\s*지원|기수혜|수혜기업|중복\s*지원|중복\s*수혜|동일\s*사업|기참여')

if __name__ == "__main__":
    PAGES = int(os.environ.get("PAGES", "10"))  # 기본 1000건
    rows, total = fetch(PAGES)
    N = len(rows)
    openN = sum(1 for r in rows if is_open(r))
    print(f"표본 {N} / totalCount {total} · open {openN}\n")

    # 1) 신청방식 단일 분포 (해당 필드 non-null 비율)
    print("[신청방식별 제공 비율] (복수 가능)")
    field_cnt = Counter()
    for r in rows:
        for f in MTHD:
            if r.get(f) not in (None, ''):
                field_cnt[f] += 1
    for f, name in MTHD.items():
        print(f"  {name:5} {field_cnt[f]/N*100:5.1f}%  ({field_cnt[f]})")

    # 2) 공고당 신청방식 개수 분포
    print("\n[공고당 신청방식 개수]")
    per_cnt = Counter()
    online_only = 0
    no_method = 0
    for r in rows:
        ms = [name for f, name in MTHD.items() if r.get(f) not in (None, '')]
        per_cnt[len(ms)] += 1
        if ms == ['온라인']:
            online_only += 1
        if not ms:
            no_method += 1
    for k in sorted(per_cnt):
        print(f"  {k}개: {per_cnt[k]/N*100:5.1f}%  ({per_cnt[k]})")
    print(f"  → 온라인 단일: {online_only/N*100:.1f}% · 방식 표기 없음: {no_method/N*100:.1f}%")

    # 3) 온라인 접수처 도메인 다양성 (자동완성/자동제출 가능성 가늠)
    print("\n[온라인 접수 URL 호스트 Top]")
    host = Counter()
    for r in rows:
        u = r.get('aply_mthd_onli_rcpt_istc')
        if u:
            m = re.search(r'https?://([^/]+)', u)
            host[m.group(1) if m else u[:30]] += 1
    for h, c in host.most_common(12):
        print(f"  {c:4}  {h}")
    print(f"  서로 다른 온라인 접수 호스트 수: {len(host)}  ← 통합 자동제출 난도 신호")

    # 4) S0-G 타진: 과거수혜 배제(prior_award) 언급률
    print("\n[S0-G 타진] aply_excl_trgt_ctnt 내 '과거 선정/중복지원' 언급률")
    prior_hit = sum(1 for r in rows if PRIOR.search((r.get('aply_excl_trgt_ctnt') or '') + ' ' + (r.get('aply_trgt_ctnt') or '')))
    excl_present = sum(1 for r in rows if (r.get('aply_excl_trgt_ctnt') or '').strip())
    print(f"  제외대상 텍스트 존재: {excl_present/N*100:.1f}%")
    print(f"  과거수혜/중복 언급:   {prior_hit/N*100:.1f}%  ← prior_award '조건'은 공고에 있음")
    print(f"  ※ 단, 이는 '제외 조건'일 뿐 '선정자 명단(누가 받았나)'은 공고 API에 없음.")
