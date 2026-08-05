# 딥분석 실행 모드 제어 상세 구현 계획

> 작성일: 2026-08-05
> 목표: 운영 API 자동화와 로컬 구독 분석이 동시에 새 유료 작업을 시작할 수 없도록 시스템적으로 보증한다.
> 범위: 실행 권한 제어와 운영 UI. 분석 알고리즘·승격 정책·수집 주기는 변경하지 않는다.

## 완료 조건

- [x] 현재 딥분석·Kordoc 흐름이 운영 가이드에 기록되고 `docs/README.md`에서 찾을 수 있다.
- [x] DB singleton control이 `paused | production_api | local_subscription`을 저장한다.
- [x] 운영 deep worker와 Kordoc worker가 `production_api`가 아니면 enqueue·claim·유료 호출을 하지 않는다.
- [x] ops `/pipeline`에서 admin/owner가 운영 자동화를 켜고 끌 수 있고 reviewer는 상태만 본다.
- [x] 로컬 `/dev/analysis-lab`이 운영 OFF일 때만 owner lease를 획득하고 배치를 시작한다.
- [x] 유효한 로컬 lease가 있으면 운영 ON 전환이 거부된다.
- [x] 알 수 없는 상태·DB 오류·만료 lease는 fail-closed다.
- [x] migration 검증, 집중 테스트, web/admin typecheck와 build가 통과한다.

## 체크포인트 1 — 문서와 계약

### 변경

- 현재 운영 흐름 가이드 작성
- 실행 모드 아키텍처 결정 기록
- 공통 mode·snapshot·effective mode·전이 판정 계약 구현

### 검증

- mode parser가 알 수 없는 값을 거부한다.
- 만료된 local lease가 `paused`로 판정된다.
- local owner만 자신의 유효 lease를 사용할 수 있다.

## 체크포인트 2 — DB와 운영 worker 게이트

### 변경

- singleton `deep_analysis_runtime_control` 테이블과 기본 `paused` row 추가
- web 서버용 조회·로컬 lease adapter 구현
- deep worker가 env 실행 정책과 DB runtime mode를 모두 통과해야 active가 되도록 변경
- Kordoc worker cycle도 같은 production gate로 차단
- standalone Kordoc CLI 우회 경로 제거

### 검증

- `paused`에서 두 운영 소비자 모두 모델 key와 storage를 요구하지 않는다.
- `production_api`여도 env가 `observe_only`이면 deep 분석은 실행되지 않는다.
- control 조회 실패 시 유료 경로가 열리지 않는다.

## 체크포인트 3 — ops와 로컬 인터페이스

### 변경

- admin 서버용 control adapter와 `/api/admin/pipeline/runtime-control` 추가
- `/pipeline` 상단에 상태·스위치·active lease 정보를 표시
- admin/owner만 mode 변경, reviewer는 read-only
- dev 전용 `/api/dev/analysis-lab/ops/runtime-control`에서 local lease 획득·갱신·해제
- 로컬 배치 POST가 owner lease를 강제하고 `claude-cli`만 허용
- 배치 탭에 로컬 권한 카드, 갱신, 실행 차단 안내 추가

### 검증

- production에서 dev API는 계속 404다.
- 운영 ON이면 local acquire와 batch start가 409다.
- local lease 중 production ON이 409다.
- 다른 owner의 renew/release가 409다.

## 체크포인트 4 — 회귀·빌드·운영 준비

### 명령

```bash
pnpm db:generate
pnpm verify:db-migrations
pnpm lab:batch-job:test
pnpm lab:application-precompute:test
pnpm --filter @cunote/web typecheck
pnpm --filter @cunote/admin typecheck
pnpm --filter @cunote/web build
pnpm --filter @cunote/admin build
```

### 배포 전 별도 확인

1. migration을 먼저 적용하고 singleton row가 `paused`인지 읽는다.
2. 새 소스를 배포해 두 worker가 runtime control 때문에 실제 모델 호출을 건너뛰는지 확인한다.
3. 그 다음에만 Cloud Run의 deep env 상한을 `active`로 올릴지 결정한다.
4. ops에서 `production_api`로 전환하고 bounded 1건으로 비용·artifact·serving까지 확인한다.

## 롤백

- 즉시 ops에서 `paused`로 전환한다.
- DB 접근 자체가 불안정하면 env `observe_only`와 `APPLICATION_PRECOMPUTE_EXECUTE=0`을 상위 차단선으로 사용한다.
- control migration은 다른 분석 테이블을 변경하지 않는 additive schema이므로 row를 `paused`로 유지한 채 이전 애플리케이션으로 롤백할 수 있다.

## 구현 기록

| 체크포인트 | 상태 | 증거 |
|---|---|---|
| 1. 문서와 계약 | 완료 | 운영 가이드·아키텍처 문서·공통 contract test |
| 2. DB·worker 게이트 | 완료 | migration 0069 적용, DB `paused` 확인, Kordoc runtime-block test |
| 3. ops·로컬 인터페이스 | 완료 | `/api/admin/pipeline/runtime-control`, `/api/dev/analysis-lab/ops/runtime-control`, 두 UI 카드 |
| 4. 회귀·빌드 | 완료 | contract·Kordoc·batch tests, migration verify, web/admin typecheck와 build 통과 |

## 적용 상태

- DB migration 0069 적용 완료. 로컬 lease 획득·해제 HTTP smoke 후 singleton은 `paused`, generation 3이다.
- 소스 구현과 빌드는 완료했지만 Cloud Run·Vercel 배포는 이 계획 범위에서 수행하지 않았다.
- 배포 전까지 현재 실행 중인 원격 worker 동작은 기존 배포 revision을 따른다.
