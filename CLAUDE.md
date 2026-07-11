# CLAUDE.md

cunote — 사업자번호 하나로 공공 지원사업을 찾고 지원서 작성을 안내하는 서비스.

## 핵심 문서

- **세션 핸드오프(재개 시 최우선)**: `docs/plans/2026-07-02-poc-execution.md` 상단 "🟡 진행 상황" blockquote
- 마스터 설계: `docs/public-support-application-guide-master-architecture.md` (단일 설계 문서. 18장 지식 루프, 17장 PoC 관문 포함)
- Gate 0 (HWP 렌더링): `docs/gate0-hwp-render-spike-plan.md` — **통과 완료** (60/60, LibreOffice+H2Orestart 확정)
- Gate 1 (라벨링): `docs/gate1-field-map-labeling-guide.md` + `spike-labels/`
- Phase 2 변환 서버: `docs/phase2-conversion-server-implementation-plan.md`

## Vercel CLI·배포 (중요)

- 메인 웹(apps/web)은 **noten 팀의 `changupnote` 프로젝트** (Root Directory: apps/web, changupnote.com). admin(apps/admin)은 team-coolwithyou의 `changupnote-ops`
- **Vercel CLI 사용·배포 시 반드시 `.env.vercel.local`의 `VERCEL_CLI_TOKEN_FULL` 토큰을 사용한다** (대화형 로그인 계정은 noten 팀이 안 보임):

```bash
VERCEL_TOKEN=$(grep -E "^VERCEL_CLI_TOKEN_FULL=" .env.vercel.local | cut -d= -f2- | tr -d '"')
vercel <command> --scope noten --token "$VERCEL_TOKEN"
```

- 배포는 Git 연동이 아니라 CLI 직접 배포: `vercel deploy --prod`. 미커밋 변경이 섞이지 않게 HEAD 커밋의 클린 worktree에서 실행할 것
- **주의(2026-07-10 실측)**: changupnote 프로젝트가 GitHub 연동(origin `coolwithyou/noten.changupnote`)된 뒤로는, CLI 배포에 로컬 git author(sw@ba-ton.kr — noten 팀 비멤버)가 메타로 붙으면 seat 승인 대기(`BLOCKED`/`TEAM_ACCESS_REQUIRED`)로 빌드가 영영 시작되지 않는다. **배포는 `.git`을 제외한 사본에서 실행할 것**: `rsync -a --exclude='.git' <worktree>/ <사본>/` (`.vercel/project.json` 포함 확인) 후 사본에서 `vercel deploy --prod`. admin(changupnote-ops, team-coolwithyou)은 author가 그 팀 소유자라 해당 없음. ops 프로젝트는 토큰이 아니라 **대화형 로그인 크레덴셜**로 `--scope team-coolwithyou` 사용
- 토큰 값은 채팅·로그에 출력 금지

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
- **관문 착수 전 외부 대조 의무**: 각 Gate·Phase 8·베타·필드테스트 착수 전에 `docs/research/CALIBRATION-TEMPLATE.md` 절차대로 외부 SOTA 대조를 수행한다 (마스터 설계 17장 "관문 공통 의례"). 관문별 대조 전제는 템플릿에 미리 등재되어 있음
- **모든 연구 문서(plan 제외)는 한글 파일명으로 작성한다**: `docs/research/` 등의 연구·검토 문서는 `YYYY-MM-DD-한글제목.md` 형식. `docs/plans/`의 plan 문서는 기존 영문 파일명 관행 유지
- 커밋 메시지: 한국어, 제목은 간결하게, 본문에 변경 이유

## UI 구현 규칙 (최우선)

- **모든 UI 작업(컴포넌트 추가/수정, 페이지 구현, 스타일링)은 `.claude/skills/shadcn` 스킬을 최우선 참조한다.** 작업 착수 전 스킬을 로드하고 그 지침(프로젝트 컨텍스트 확인 `npx shadcn@latest info`, 컴포넌트 검색/설치 절차)을 따른다.
- 컴포넌트는 `npx shadcn@latest add <name>`으로 설치한다 (apps/web에서 실행, base-nova 스타일 자동 해석). Button/Card/Dialog 등 shadcn에 존재하는 primitive를 hand-roll 하지 않는다.
- 블럭(sidebar-07, login-03 등)은 직접 add 하지 않는다(데모 라우트 파일과 충돌) — `npx shadcn@latest view <block>`으로 소스를 열람해 패턴만 이식한다.
- 색·간격·radius·그림자는 `apps/web/src/app/globals.css`의 토큰(CSS 변수/Tailwind 유틸)만 사용한다. hex 하드코딩 금지.
- 드리프트 스캔: `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'` 가 0이어야 한다 (동적 좌표 오버레이 예외 없음 — Toggle/Button으로 치환).

## 마이그레이션

- `pnpm db:generate` → `pnpm db:migrate` 순서 준수. `db:push` 단독 사용 금지
- 주의: 0018~0024는 수동 작성되어 스냅샷과 어긋나 있었고 0025에서 청산됨. generate 결과에 기존 객체 재생성이 섞이면 SQL에서 제거하고 스냅샷만 유지할 것

## Gate 1 라벨링

- 사전 라벨(opus-prelabel) → 사람 검수 확정의 2단계. AI 라벨을 검수 없이 golden으로 승격 금지 (순환성)
- 판정 규칙과 표준 key 사전은 기준서가 단일 원천. 애매 케이스는 기준서 "판정 사례집"에 추가
