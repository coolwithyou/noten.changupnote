# NEXT SESSION IMPLEMENTATION TRIGGER

새 Codex 세션에서 이 파일을 먼저 읽고 구현을 시작한다. 목표는 설계를 더 늘리는 것이 아니라 **기본 구조를 만들고 검증 가능한 세로 슬라이스를 띄우는 것**이다.

## 시작 메시지

새 세션 첫 메시지로 아래를 그대로 사용한다.

```
이 저장소(`/Users/ffgg/noten.works/cunote`)에서 창업노트 구현을 시작해줘.

먼저 `NEXT_SESSION_IMPLEMENTATION_TRIGGER.md`, `창업노트_구현착수_가이드.md`, `창업노트_DB스키마_통합.md`, `창업노트_정규화스키마_설계.md`, `S0_KStartup_PoC_결과.md`, `S0_Popbill_CheckBizInfo_게이트.md`를 읽고, 문서 기준으로 T0 기반 구조부터 구현해줘.

구현 우선순위는 T0 → T1(K-Startup 수집/정규화) → T4(규칙 매칭) 순서야.
첫 세션 목표는 K-Startup 샘플/실응답을 `grants`, `grant_criteria` 형태로 정규화하고, 가상 회사 프로필에 대해 `eligible / conditional / ineligible`와 `rule_trace`가 나오는 최소 세로 슬라이스를 만드는 거야.

아직 하지 말 것:
- 기업마당 전체 수집/LLM 추출 자동화
- Vercel 배포
- 프로덕션 DB 연결/마이그레이션 적용
- 팝빌 원문 캐시 정책 확정 전 장기 저장 구현
- 정확도 수치 홍보 또는 완료 주장

검증은 로컬 테스트/스크립트로 끝까지 실행하고, 커밋 메시지는 한글로 작성해줘.
```

## 현재 기준 상태

- Git 저장소 초기화 완료, 브랜치 `main`.
- 최신 커밋 기준 문서와 PoC는 검증됨.
- K-Startup PoC 완료: 구조화 필드 기반 척추 매칭 가능.
- 팝빌 `checkBizInfo` 로컬 호출 성공: `result=100`, 핵심 후보 필드 채움 확인.
- 남은 외부 게이트: Vercel route 팝빌 SDK/IP 제한, 팝빌 캐시 약관, S0-C2 골든셋 P/R, S0-E dedup.

## 구현 첫 범위

### T0 기반

새 구현 프로젝트는 문서상 `cunote-web`이지만, 현재 저장소에서 바로 시작한다면 아래 구조를 우선 만든다.

```
apps/web/
packages/core/
packages/contracts/
db/
```

첫 구현 산출물:
- `packages/contracts`:
  - `grant_criteria` JSON Schema
  - 핵심 TS 타입
- `packages/core`:
  - K-Startup 필드 파서
  - `grant_criteria` 생성기
  - 규칙 매칭 엔진
  - `rule_trace` 생성
- `db`:
  - Drizzle schema 초안 또는 SQL 초안
  - `grants`, `grant_criteria`, `grant_raw`, `company_profiles`, `company_enrichment_cache`, `match_state`, `match_events`
- `apps/web`:
  - 아직 UI 완성보다 API/테스트 우선

### T1 K-Startup

우선 `samples/kstartup_announcement_sample.json`으로 동작하게 한다. 이후 `KSTARTUP_SERVICE_KEY`가 있으면 실 API를 붙인다.

필수 파싱:
- `supt_regin` → region criteria
- `biz_enyy` → biz_age criteria + preliminary 허용
- `biz_trgt_age` → founder age/trait criteria
- `aply_trgt_ctnt` / `aply_excl_trgt_ctnt` → scoped unknown 또는 경량 exclusion
- `pbanc_rcpt_bgng_dt` / `pbanc_rcpt_end_dt` → status/open 판단

### T4 규칙 매칭

`poc/kstartup_match_demo.py`의 판단을 TypeScript core 로직으로 이식한다.

출력:
- `eligibility`: `eligible | conditional | ineligible`
- `fit_score`
- `rule_trace`
- `unknown_fields`
- `next_question` 후보

## 검증 커맨드

구현 전 현재 문서/PoC 검증:
```
git status --short --branch
node --check poc/popbill_checkbizinfo_probe.mjs
python3 -m py_compile poc/*.py
```

팝빌 로컬 재검증이 필요할 때:
```
tmpdir=$(mktemp -d /tmp/cunote-popbill.XXXXXX) && npm install --prefix "$tmpdir" popbill@1.64.2 >/dev/null 2>&1 && NODE_PATH="$tmpdir/node_modules" node poc/popbill_checkbizinfo_probe.mjs; code=$?; rm -rf "$tmpdir"; exit $code
```

문서 참조 검증:
```
python3 - <<'PY'
from pathlib import Path
import re
missing=[]
for p in Path('.').glob('*.md'):
    text=p.read_text(encoding='utf-8')
    for m in re.findall(r'`([^`\\s]+\\.(?:md|py|json|mjs))`', text):
        if '/' in m:
            if not Path(m).exists(): missing.append((p.name,m))
        elif not Path(m).exists():
            missing.append((p.name,m))
if missing:
    print('MISSING')
    for src, ref in missing:
        print(f'{src}: {ref}')
else:
    print('all referenced md/py/json/mjs paths exist')
PY
```

## 구현 원칙

- 정확도 주장은 골든셋 P/R 전까지 하지 않는다.
- `unknown`은 실패가 아니라 조건부로 취급한다.
- LLM 추출과 규칙 판정은 분리한다.
- 모든 추출/매칭 결과는 버전 태그를 남길 수 있게 설계한다.
- 팝빌 대표자명은 PII다. 국세청 3요소 검증을 주 근거로 둔다.
- 팝빌 `establishDate`는 업력 후보값이지, 표본 대조 전 확정 진실로 과신하지 않는다.
- 원문 응답 캐시는 약관 확인 전 장기 저장 구현을 보류한다.

## 완료 기준

첫 구현 세션의 완료 기준:
- 로컬 테스트로 K-Startup 샘플 1건 이상이 `grant_criteria`로 변환된다.
- 가상 회사 프로필 1개와 매칭했을 때 `eligible / conditional / ineligible` 중 하나와 `rule_trace`가 나온다.
- 결과가 `poc/kstartup_match_demo.py`의 방향과 크게 다르지 않다.
- 구현 변경은 한글 커밋 메시지로 커밋된다.
