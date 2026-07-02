# CLAUDE.md

cunote — 사업자번호 하나로 공공 지원사업을 찾고 지원서 작성을 안내하는 서비스.

## 핵심 문서

- **세션 핸드오프(재개 시 최우선)**: `docs/plans/2026-07-02-poc-execution.md` 상단 "🟡 진행 상황" blockquote
- 마스터 설계: `docs/public-support-application-guide-master-architecture.md` (단일 설계 문서. 18장 지식 루프, 17장 PoC 관문 포함)
- Gate 0 (HWP 렌더링): `docs/gate0-hwp-render-spike-plan.md` — **통과 완료** (60/60, LibreOffice+H2Orestart 확정)
- Gate 1 (라벨링): `docs/gate1-field-map-labeling-guide.md` + `spike-labels/`
- Phase 2 변환 서버: `docs/phase2-conversion-server-implementation-plan.md`

## Cowork/샌드박스 환경에서의 git 규칙 (중요)

이 저장소가 Cowork 샌드박스에 마운트되면 **파일 삭제(unlink)가 전면 차단**된다 (생성·수정·rename은 허용). git이 작업 후 lock 파일을 지우지 못해 다음 git 명령이 막힌다.

**모든 git 쓰기 명령(add/commit 등) 직전에 반드시 실행:**

```bash
mkdir -p .git/stale-locks && mv .git/*.lock .git/stale-locks/ 2>/dev/null || true
```

- 커밋 author: `git -c user.name="coolwithyou" -c user.email="sw@ba-ton.kr" commit ...`
- `.git/stale-locks/`와 `.git/objects/*/tmp_obj_*` 잔재물은 무해하다. 사용자가 로컬에서 가끔 비우면 된다
- 같은 이유로 샌드박스에서는 파일을 지우는 대신 rename하거나 덮어쓴다. `rm`이 필요한 정리 작업은 사용자에게 위임

## 작업 체계

- 구현·대량 작업은 Opus 서브에이전트에 위임하고, 메인(Fable)은 계획·설계·검수·피드백을 담당한다 (토큰 절약)
- 커밋 메시지: 한국어, 제목은 간결하게, 본문에 변경 이유

## 마이그레이션

- `pnpm db:generate` → `pnpm db:migrate` 순서 준수. `db:push` 단독 사용 금지
- 주의: 0018~0024는 수동 작성되어 스냅샷과 어긋나 있었고 0025에서 청산됨. generate 결과에 기존 객체 재생성이 섞이면 SQL에서 제거하고 스냅샷만 유지할 것

## Gate 1 라벨링

- 사전 라벨(opus-prelabel) → 사람 검수 확정의 2단계. AI 라벨을 검수 없이 golden으로 승격 금지 (순환성)
- 판정 규칙과 표준 key 사전은 기준서가 단일 원천. 애매 케이스는 기준서 "판정 사례집"에 추가
