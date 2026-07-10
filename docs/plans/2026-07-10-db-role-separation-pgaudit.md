# 웹/admin DB 역할 분리 + pgaudit 도입 계획

> 설계 근거: `docs/plans/2026-07-09-ai-credit-system.md` 4.13(RLS·역할 실측) / 12.7(기타 통제) / P7·오픈 퀘스천 18.12.
> 상태: **계획 문서**(P7 요구 = "최소한 계획 문서화"). 실제 역할 분리·pgaudit 적용은 후속 실행 과제.
> 작성일: 2026-07-10.

## 0. 요약

- 크레딧 도메인의 접근통제 근본 과제는 **단일 BYPASSRLS 역할 구조**다. 웹앱·admin·배치가 모두 같은
  `postgres`(BYPASSRLS) 역할로 접속하므로, ENABLE/FORCE RLS 는 이 역할에 무의미하고 **코드 레벨 가드가 실질 1선**이다.
- 목표는 (1) 웹앱을 **non-BYPASSRLS 최소 권한 역할**로 내려 RLS 를 2선으로 실제 작동시키고, (2) admin·배치를 별도 역할로 분리하며, (3) **pgaudit** 로 트리거 무력화 시도(`DISABLE TRIGGER`·`session_replication_role`)를 알람 대상에 등재하는 것.

## 1. 현 상태 (실측 — 2026-07-10)

4.13 의 "P1 착수 시 실측 의무"에 따라 운영 공용 DB(Supabase, aws-1-ap-northeast-2 pooler)에서 접속 역할을 측정했다:

```sql
SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
```

| 항목 | 값 |
|---|---|
| `current_user` | `postgres` |
| `rolbypassrls` | **true** |
| `rolsuper` | false |
| pgaudit 설치 | **없음** (`pg_extension` 조회 결과 미설치) |

**해석(4.13 분기표):** BYPASSRLS 유력 분기다. 크레딧 전 테이블에 ENABLE + FORCE RLS 를 적용해도(이미 적용됨) `postgres` 역할은 정책 평가를 받지 않고 통과한다. 따라서:

- RLS(4.13)는 **2선 방어**다. 실질 1선은 크레딧 리포지토리의 `withCunoteDbUser(userId)` 컨텍스트 강제 가드(코드 레벨)다.
- append-only 트리거(4.3)도 이 역할이 `ALTER TABLE … DISABLE TRIGGER` / `SET session_replication_role='replica'` 한 줄로 우회 가능하다 → chainHash 체인(2선, 14.2 대사) 이 실제 변조 탐지의 근거다.
- 웹앱에 user 컨텍스트를 세팅하지 않는 경로(`transactionWithOptionalUser(userId=undefined)`)가 존재하며, 이 경로에서 크레딧 테이블을 만지면 RLS·트리거와 무관하게 우회된다 → 리포지토리 가드가 이를 런타임 예외로 막는다.

## 2. 목표 상태

| 역할 | 권한 | 용도 |
|---|---|---|
| `cunote_web` | **non-BYPASSRLS**, 크레딧/서비스 테이블에 최소 CRUD, RLS 정책 평가 대상 | 웹앱(apps/web) 런타임. user 컨텍스트(`app.current_user_id`)로 RLS 가 실제 격리 |
| `cunote_admin` | non-BYPASSRLS + 크레딧 조회/관리 테이블 접근(RLS 예외 함수 또는 별도 정책) | admin(apps/admin) 런타임. user 스코프가 아니라 운영자 스코프 |
| `cunote_batch` | 시스템 경로(cron·웹훅·대사) 전용. 원장 append + recon_runs/audit INSERT 권한, 트리거 DISABLE 불가 | 크론·내부 엔드포인트·대사 |
| `postgres`(현행 BYPASSRLS) | 마이그레이션·스키마 변경 전용. 런타임에서 사용 금지 | DDL·긴급 운영 |

- 핵심: **런타임 3역할 모두 BYPASSRLS 를 제거**한다. 그래야 FORCE RLS 가 웹앱에 실제로 걸리고, 트리거 우회가 슈퍼권한 없이는 불가능해진다.
- `cunote_web` 은 크레딧 원장 직접 UPDATE/DELETE 권한을 갖지 않는다(append-only 트리거 + 권한 이중화).

## 3. Supabase 에서의 실행 방법

Supabase 는 관리형이라 슈퍼유저 접근이 제한적이다. 실행 순서:

1. **역할 생성**(Supabase SQL Editor, 서비스 role 로):
   ```sql
   CREATE ROLE cunote_web LOGIN PASSWORD '<vault>' NOBYPASSRLS;
   CREATE ROLE cunote_admin LOGIN PASSWORD '<vault>' NOBYPASSRLS;
   CREATE ROLE cunote_batch LOGIN PASSWORD '<vault>' NOBYPASSRLS;
   ```
2. **권한 부여**: 스키마 usage + 테이블별 최소 GRANT. 크레딧 원장은 web/admin 에 SELECT/INSERT 만(UPDATE/DELETE 없음 — 정정은 reversal INSERT). batch 는 recon_runs·audit INSERT.
3. **RLS 정책 재확인**: `credit_wallets_self_select` 등 기존 정책은 `app_private.current_user_id()` 기반. non-BYPASSRLS 역할에서 실제 평가되므로, admin 조회 경로는 별도 정책(예: `current_setting('app.role') = 'admin'`) 또는 SECURITY DEFINER 함수로 우회 설계.
4. **커넥션 문자열 분리**: `DATABASE_URL`(web=cunote_web), admin 앱 `DATABASE_URL`(=cunote_admin), 크론/내부 실행은 `cunote_batch`. Supabase pooler 는 역할별 유저를 지원.
5. **트리거 소유권**: append-only 트리거 함수(`app_private.reject_mutation`)를 런타임 역할이 DISABLE 할 수 없도록 테이블 소유자를 런타임 역할과 분리(소유자만 DISABLE 가능).

## 4. pgaudit 도입 방안

목적: 트리거 무력화·직접 원장 변이 시도를 감사 로그로 남겨 **사후 부인 방지**를 강화(12.7, M4-보안).

1. **확장 설치**(Supabase 는 pgaudit 를 지원 확장으로 제공):
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgaudit;
   ```
2. **감사 대상 설정**: DDL·역할·권한 변경을 전수 기록.
   ```sql
   ALTER SYSTEM SET pgaudit.log = 'ddl, role';
   ```
   - 특히 다음을 **알람 대상**으로 등재(로그 파이프라인에서 패턴 매칭):
     - `ALTER TABLE ... DISABLE TRIGGER` (append-only 트리거 무력화 시도)
     - `SET session_replication_role` / `SET session_replication_role = 'replica'` (트리거 전역 우회)
     - 크레딧 테이블 대상 직접 `UPDATE`/`DELETE`(트리거가 막지만, 시도 자체를 감사)
     - 역할·권한 변경(`CREATE ROLE`, `ALTER ROLE ... BYPASSRLS`, `GRANT`)
3. **알람 연동**: Supabase 로그 → 로그 드레인/알람(트리거 무력화·session_replication_role 문자열 매칭 시 즉시 통지). 초기에는 일일 대사(14.1)의 chainHash 재검증이 변조를 잡고, pgaudit 는 "누가·언제·무엇을" 보강한다.

## 5. 전환 순서와 리스크

| 단계 | 작업 | 리스크 | 완화 |
|---|---|---|---|
| 1 | pgaudit 설치 + ddl/role 감사 활성화 | 로그량 증가 | ddl/role 만 대상(전 쿼리 아님) |
| 2 | `cunote_web`/`cunote_admin`/`cunote_batch` 역할 생성·권한 부여 | 권한 누락 시 런타임 500 | 프리뷰 환경에서 전 라우트 스모크 후 운영 반영 |
| 3 | 테이블 소유권을 런타임 역할과 분리(트리거 DISABLE 차단) | 마이그레이션 소유자 변경 필요 | DDL 은 `postgres` 로만 수행하도록 파이프라인 고정 |
| 4 | 커넥션 문자열을 역할별로 교체(web→cunote_web 등) | RLS 실제 작동으로 기존 우회 경로가 막혀 일부 조회 실패 | 4.13 검증 3종(admin 조회·타인 지갑 0행·user 컨텍스트 부재 가드)을 전환 후 재실행 |
| 5 | `postgres` 를 런타임에서 제거(마이그레이션 전용화) | 긴급 운영 시 접근 제약 | break-glass 절차 문서화 |

**롤백**: 각 단계는 커넥션 문자열을 `postgres` 로 되돌리면 즉시 원복된다(스키마 불변). 역할 생성·pgaudit 는 비파괴적이라 유지해도 무방.

## 6. 완료 판정(후속 실행 시)

- 웹 커넥션(`cunote_web`, user 컨텍스트)으로 타인 지갑 조회 = **0행**(RLS 실제 작동).
- `cunote_web` 으로 `ALTER TABLE credit_ledger DISABLE TRIGGER` 시도 = **권한 거부**.
- `cunote_web`/`cunote_batch` 로 `credit_ledger` 직접 `UPDATE` = 트리거 예외 + pgaudit 로그.
- 4.13 검증 3종 통과 + 대사 5 scope ok 유지.
