# 창업노트 완결형 SaaS 구현 계획

작성일: 2026-06-28

## 목표

창업노트를 단순 데모/기능 묶음이 아니라 사용자가 유입, 가입, 회사 설정, 매칭 확인, 신청 준비, 계정 관리, 법무/지원 페이지까지 끊김 없이 사용할 수 있는 MVP SaaS로 완성한다.

## 현재 구현 상태

- 공개 유입: `/` 랜딩, `/matches` 사업자번호 기반 매칭 프리뷰, `/login`
- 앱 핵심: `/dashboard`, `/roadmap`, `/grants/[grantId]`
- 신청 실행: `/applications` 신청 파이프라인, 지원서 초안 Markdown 다운로드, 신청 일정 캘린더 파일 다운로드
- 워크스페이스 운영: `/team` 팀 초대/권한, `/billing` 플랜/청구 상태
- 고객지원/전환: `/support` 문의 접수, `/account` 문의 이력/답장, `/billing` 플랜 전환 요청, `support_tickets` 운영 큐
- 인앱 운영: 사용자 알림 설정, 마감/새 매칭/신청 리마인더/고객지원 SLA/입력 필요 알림센터, 사용자별 읽음/숨김 상태
- 운영/검증: `/admin`, `/internal/live-match`
- API: 회사 생성/전환/검증, 동의, 알림, 프로필 필드, 매칭 이벤트, 지원서 초안 저장, 팀 초대/수락/역할 변경, 플랜 전환 요청, 지원 티켓 답장, 알림 읽음/숨김
- 남은 고도화: 결제 provider 연동, 서식별 export, 고객지원 백오피스, 운영 법무 최종 확정

## MVP 사용자 흐름

1. 방문자는 랜딩에서 사업자번호를 입력한다.
2. `/matches`에서 매칭 프리뷰를 확인한다.
3. 결과 저장 또는 신청 준비를 위해 `/login`에서 가입/로그인한다.
4. 로그인 후 `/onboarding`에서 회사, 동의, 알림, 자가신고 프로필을 완성한다.
5. `/dashboard`에서 현재 기회를 확인하고 필요한 질문을 보강한다.
6. `/grants/[grantId]`에서 신청 준비 시트, 제출서류, AI 초안을 작성한다.
7. `/applications`에서 저장, 준비, 제출, 보류 상태를 관리하고 초안 export 이력을 만든다.
8. `/roadmap`에서 곧 열릴 기회를 추적한다.
9. `/team`에서 회사 멤버를 초대하고 역할을 조정한다.
10. `/billing`에서 현재 플랜, 사용량, 청구 연동 상태를 확인하고 유료 전환 상담을 접수한다.
11. `/settings`와 `/account`에서 계정/회사/알림/동의 상태를 관리하고 계정 데이터를 내려받는다.
12. `/support`에서 문의 티켓을 접수하고 `/account`에서 처리 상태와 공개 답변을 확인한다.
13. 운영팀은 `/admin`에서 최근 문의에 공개 답변 또는 내부 메모를 남긴다.
14. `/terms`, `/privacy`, `/support`에서 서비스 조건, 개인정보 처리방침, 지원 창구를 확인한다.

## 1차 구현 범위

### 라우트

- `/account`: 사용자 계정, 소속 회사, 보안/세션 상태, 주요 작업 링크
- `/settings`: 회사 선택, 개인정보 동의, 알림, 사업자 검증, 수기 프로필 편집
- `/onboarding`: 가입 직후 회사 설정을 끝내는 3단계 안내 흐름
- `/terms`: 서비스 이용약관
- `/privacy`: 개인정보 처리방침
- `/support`: 고객지원/문의/운영 상태 안내

### 내비게이션

- 계정 메뉴에 내 계정, 설정, 온보딩, 고객지원 링크 추가
- 앱 헤더의 주요 링크를 기회 맵, 매칭, 로드맵, 설정 중심으로 정리
- 랜딩/로그인/공개 페이지에서 약관과 개인정보 링크 접근 가능하게 유지

### 데이터/권한

- `/account`, `/settings`, `/onboarding`은 `requireCompanyAccess()`로 보호한다.
- `/terms`, `/privacy`, `/support`는 공개 라우트로 둔다.
- 기존 회사/동의/알림/프로필 API를 재사용해 중복 API를 만들지 않는다.

### 디자인

- `DESIGN.md`의 refined-minimal, Work zone 원칙을 따른다.
- 새 앱 화면은 shadcn `Card`, `Button`, `Badge`, `Empty`, `Field` 계열을 우선 사용한다.
- 임의 hex 색상 대신 `--background`, `--card`, `--border`, `--primary`, `--muted-foreground`, TDS bridge token을 사용한다.
- 법무/지원 페이지는 긴 문서를 읽기 쉬운 단일 컬럼과 오른쪽 요약 rail로 구성한다.

## 2차 구현 범위

### 신청 파이프라인

- `/applications`를 보호 라우트로 추가한다.
- 별도 테이블을 만들지 않고 기존 매칭 결과, `feedback(kind: saved|dismissed|wrong|applied|note)`, `grant_document_drafts`를 조합해 상태판을 파생한다.
- 상태는 추천, 저장됨, 서류 준비, 제출 완료, 보류로 정규화한다.
- 카드 액션은 기존 매칭 feedback API를 재사용해 API surface 증가를 막는다.

### 문서 내보내기

- `GET /api/web/document-drafts/[draftId]/download`로 저장된 초안 Markdown을 파일로 내려준다.
- 다운로드 버튼은 현재 편집 중인 내용을 먼저 저장하고 draft status를 `exported`로 바꾼 뒤 다운로드한다.
- 파일명은 한글 문서명을 유지하되 `filename*` UTF-8 헤더와 ASCII fallback을 함께 제공한다.

### 디자인 반영

- 변경된 `DESIGN.md` 기준으로 Work zone 표면은 장식 없이 `Card`, `Button`, `StatusBadge`, `Empty` 조합을 사용한다.
- `DESIGN.md`의 토큰 원칙을 따라 새 CSS에는 임의 hex/off-palette 색상과 스케일 밖 radius를 추가하지 않는다.
- App surface radius는 16px, 입력/포커스 보조 radius는 14px, pill은 999px만 사용한다.

## 3차 구현 범위

### 팀과 권한

- `/team`을 보호 라우트로 추가한다.
- 현재 회사의 멤버와 역할은 DB `user_company` + `users`에서 읽고, 데모/DB 실패 시 현재 사용자 1명으로 폴백한다.
- 실제 초대 발송과 역할 변경 API는 아직 만들지 않고 `초대 준비중` 상태로 표시한다.
- 계정 메뉴와 `/account`, `/settings`에서 팀 화면으로 이동할 수 있게 한다.

### 플랜과 청구

- `/billing`을 보호 라우트로 추가한다.
- 현재 회사/팀/AI 초안/활성 기회를 Early Access 사용량으로 보여준다.
- 결제 연동 전에는 카드 정보나 청구 정보를 수집하지 않는다고 명시한다.
- 실제 결제 provider, 영수증, 유료 플랜 전환은 후속 API 영역으로 남긴다.

## 4차 구현 범위

### 고객지원 티켓

- `/support`에 문의 접수 폼을 추가한다.
- `POST /api/web/support/tickets` 공개 API로 제품, 계정/권한, 개인정보, 플랜/청구, 오류 신고 유형을 접수한다.
- `support_tickets` 테이블에 이메일, 유형, 제목, 내용, 상태, 우선순위, 세션/회사 metadata를 저장한다.
- DB migration이 아직 적용되지 않은 환경에서는 사용자에게 `queued` receipt를 돌려 페이지 흐름이 깨지지 않게 한다.
- `/admin` 플라이휠 표면에 `support_tickets` 카운트와 최근 문의를 추가한다.

## 5차 구현 범위

### 팀 관리 write path

- `team_invitations` 테이블을 추가하고 초대 이메일, 역할, 토큰 hash, 상태, 만료일, 초대한 사용자, 수락 사용자를 저장한다.
- `/team`의 `초대 준비중` 상태를 제거하고 이메일 + 역할 기반 초대 링크 생성 UI를 추가한다.
- `POST /api/web/team/invitations`는 소유자/관리자만 사용할 수 있고 DB 미연결 환경에서는 `queued` 성격의 `persisted: false` receipt를 반환한다.
- `/team/invite/[token]` 공개 링크와 `POST /api/web/team/invitations/accept` 수락 API를 추가한다.
- `PATCH /api/web/team/members/[userId]`로 소유자/관리자가 `admin/member/viewer` 역할을 변경할 수 있게 한다. `owner` 변경과 자기 역할 변경은 제한한다.
- RLS는 초대 테이블에 적용하고, 기존 `user_company`에는 초대 수락 insert 및 회사 생성자 기준 멤버 조회/역할 변경 정책을 보강한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Input`, `Select`, `Button`, `Card`, semantic token, 16/14/999 radius만 사용한다.

## 6차 구현 범위

### 플랜 전환 요청

- `POST /api/web/billing/plan-request`를 추가하고 회사 write 권한을 가진 사용자만 호출할 수 있게 한다.
- 별도 결제 테이블을 만들기 전까지 `support_tickets`의 `billing` category와 `metadata.kind = billing_plan_request`로 전환 의사를 기록한다.
- `/billing`에 상담 이메일, 담당자, 희망 플랜, 예상 좌석, 청구 주기, 요청사항 form을 추가한다.
- 접수 결과는 `open` 또는 `queued` receipt로 표시해 DB migration/연결 상태와 무관하게 사용자 흐름이 끊기지 않게 한다.
- 실제 카드/계좌/영수증 처리는 provider 선택 이후 후속으로 분리한다.

## 7차 구현 범위

### 고객지원 백오피스 처리

- `/admin`의 `support_tickets` 최근 항목을 읽기 전용 문자열 목록에서 처리 가능한 운영 패널로 확장한다.
- `PATCH /api/admin/flywheel/support-tickets/[ticketId]`를 추가해 어드민이 상태와 우선순위를 바꿀 수 있게 한다.
- 상태는 `open`, `in_progress`, `waiting`, `resolved`, `closed`로, 우선순위는 `low`, `normal`, `high`, `urgent`로 정규화한다.
- 변경 이력은 `support_tickets.metadata.adminEvents`에 최근 이벤트로 누적해 별도 audit table 없이도 MVP 운영 추적이 가능하게 한다.
- 권한 경계는 기존 `requireAdminAccess()`로 유지하고, static admin verifier와 HTTP smoke에서 보호/처리 경로를 확인한다.

## 8차 구현 범위

### 고객지원 커뮤니케이션 로그

- `support_ticket_messages` 테이블을 추가해 최초 접수 이후의 사용자 답장, 관리자 공개 답변, 내부 메모를 저장한다.
- 메시지 작성자는 `user`, `admin`, `system`으로, 공개 범위는 `public`, `internal`로 정규화한다.
- `/account`에 내 문의 패널을 추가하고 공개 메시지 thread, 상태, 최신 메시지, 답장 입력을 제공한다.
- `POST /api/web/support/tickets/[ticketId]/messages`는 회사/세션 접근이 확인된 티켓에만 사용자 답장을 저장한다.
- `/admin`의 support ticket 패널에 공개 답변/내부 메모 입력을 추가하고 `POST /api/admin/flywheel/support-tickets/[ticketId]/messages`로 저장한다.
- 공개 답변은 사용자 계정 화면에 노출하고 티켓 상태를 `waiting`으로 바꾸며, 내부 메모는 관리자 플라이휠에서만 최신 메모로 확인한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone으로 처리해 shadcn primitive, semantic token, 16/14px radius를 유지한다.
- 검증은 route policy, admin routes, DB migration, web HTTP smoke, typecheck/build에 포함한다.

## 9차 구현 범위

### 운영 법무 고지와 지원 정책

- `getLegalConfig()` 서버 설정을 추가해 서비스명, 운영자, 지원 이메일, 개인정보 문의처, 시행일, 정책 버전을 환경값으로 관리한다.
- `/terms`와 `/privacy`에서 “초안” 표현을 제거하고, 운영자/문의처/버전/시행일 요약을 공통 LegalPage rail에 표시한다.
- 약관에는 요금/유료 전환, 고객지원/통지, AI 초안 책임 범위를 명시한다.
- 개인정보 처리방침에는 보유/삭제, 위탁/인프라, 안전성 조치, 개인정보 문의와 권리 행사 경로를 명시한다.
- `/support`는 같은 지원 이메일 설정을 사용하고, 로그인 사용자는 `/account#account-support-tickets`에서 내 문의 기록으로 이어지게 한다.
- 지원 페이지에 접수 확인, 우선 처리 기준, 운영 문의처를 Work zone 패널로 추가한다.

## 10차 구현 범위

### 신청 파이프라인 후속 관리

- `/applications`의 제출 완료, 선정, 탈락, 신청 막힘 카드에 담당자, 리마인더 날짜, 결과/후속 메모 입력을 추가한다.
- 새 테이블을 만들지 않고 기존 `feedback.value.payload`에 `source = application_pipeline`, `assigneeName`, `reminderAt`, `outcomeNote`를 저장한다.
- 파이프라인 서버 집계는 최신 단계 feedback과 별도로 가장 최근의 신청 운영 메타 payload를 찾아 카드에 표시한다.
- 결과대기/선정/탈락/막힘 stage label을 서버와 클라이언트 모두에서 일관되게 표시한다.
- 담당자/리마인더/결과 메모는 신청 결과 발표일, 보완 요청, 선정 후 의무, 탈락 사유 기록에 사용한다.
- 외부 캘린더/이메일 알림은 후속 provider 연동 범위로 남기고, 현재 MVP에서는 서비스 내 신청 보드에서 확인 가능하게 한다.

## 11차 구현 범위

### 고객지원 담당자와 SLA

- `support_tickets.metadata`에 `assignedTo`, `slaDueAt`을 저장해 별도 테이블 없이 MVP 운영 담당자와 응답 기준일을 관리한다.
- `/admin` support ticket 패널에서 담당자와 SLA 날짜를 입력하고 기존 상태/우선순위 PATCH 경로로 저장한다.
- admin flywheel snapshot은 SLA 상태를 `none`, `ok`, `due_soon`, `overdue`로 계산해 운영자가 지연 위험을 바로 볼 수 있게 한다.
- `/admin` support ticket 패널은 상태, 우선순위, SLA 상태, 담당자 검색 필터를 제공해 운영 큐를 좁혀 볼 수 있게 한다.
- `/account`의 내 문의 패널에는 내부 담당자는 숨기고 예상 응답 기준일만 노출한다.
- 이메일/SMS/Slack 알림은 provider 연동 전까지 보류하고, 현재는 서비스 내 운영 콘솔과 계정 화면에서 확인한다.

## 12차 구현 범위

### 팀 초대 재발행/철회와 좌석 제한

- Early Access 좌석 한도는 `workspace/limits.ts`의 5석 기준을 서버와 화면에서 함께 사용한다.
- 신규 초대 생성 시 활성 멤버와 아직 만료되지 않은 pending 초대를 예약 좌석으로 합산해 한도를 초과하면 `team_seat_limit_exceeded`로 거절한다.
- 초대 수락 시에도 좌석을 다시 확인해 오래된 초대나 동시 처리로 좌석 한도를 넘는 멤버 추가를 막는다.
- `POST /api/web/team/invitations/[invitationId]/resend`는 pending/expired 초대의 토큰과 만료일을 재발행하고 새 링크를 반환한다.
- `DELETE /api/web/team/invitations/[invitationId]`는 pending 초대를 `revoked`로 바꿔 예약 좌석을 해제한다.
- `/team`은 좌석 사용량, 대기 초대 수, 남은 좌석을 Work zone 패널로 보여주고 한도 도달 시 새 초대 생성을 비활성화한다.
- 초대 이력 row에는 상태 배지와 재발행/철회/복사 액션을 붙이고, shadcn `Button`과 semantic token만 사용한다.

## 13차 구현 범위

### 인앱 알림센터와 읽음 상태

- `notification_receipts` 테이블을 추가해 사용자/회사/알림 id 단위의 `unread`, `read`, `dismissed` 상태를 저장한다.
- RLS는 본인 사용자 id와 해당 회사 멤버십을 동시에 만족할 때만 알림 receipt를 읽고 쓸 수 있게 한다.
- 알림 feed 생성 시 `notification_settings`의 마감 알림, 새 매칭 설정을 반영해 사용자가 끈 알림 유형은 숨긴다.
- `/api/web/notification-feed`는 기존 read-only feed 대신 알림 설정과 receipt가 합쳐진 `NotificationCenterResult`를 반환한다.
- `POST /api/web/notification-feed/receipt`를 추가해 알림을 읽음 처리하거나 숨김 처리한다.
- `/dashboard`의 알림 패널은 읽음 수, 읽음 처리, 숨김 액션을 제공한다.
- `/account`에는 같은 알림센터를 추가해 계정/지원 흐름에서도 마감, 새 매칭, 입력 필요 알림을 확인할 수 있게 한다.
- DB migration 전 또는 메모리 어댑터 환경에서는 메모리 receipt fallback으로 화면 흐름이 끊기지 않게 한다.
- 외부 push/email 발송, 배치 스케줄링, 고급 snooze는 provider 선택 이후 후속으로 분리한다.

## 14차 구현 범위

### 신청 패키지 Markdown 내보내기

- `GET /api/web/grants/[grantId]/package`를 추가해 공고 단위 신청 패키지를 Markdown 파일로 내려준다.
- 패키지에는 공고 요약, 혜택, 제출서류 taxonomy, 원문/R2 보관 첨부 URL, 변환 Markdown URL, 복붙 프로필, 추가 입력 필요 항목, 조건 확인표, 저장된 AI 초안을 포함한다.
- 새 테이블을 만들지 않고 기존 `ApplySheet` 정규화 결과와 `grant_document_drafts` 저장 초안을 조합한다.
- 샘플 공고처럼 저장 DB UUID가 아닌 경우에도 공고/서류/첨부 패키지는 생성하고, 저장된 초안만 제외한다.
- 개별 초안 다운로드와 패키지 다운로드가 같은 UTF-8 파일명/Markdown 응답 헤더 helper를 사용하게 한다.
- `/grants/[grantId]` 지원서 준비 패널에는 shadcn `buttonVariants` 기반 `패키지 내보내기` 보조 액션을 추가한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone을 유지해 새 임의 hex 색상이나 스케일 밖 radius를 추가하지 않는다.

## 15차 구현 범위

### 신청 일정 캘린더 내보내기

- `GET /api/web/applications/[grantId]/calendar`를 추가해 공고별 신청 일정을 `.ics` 파일로 내려준다.
- 캘린더에는 공고 마감일과 신청 파이프라인의 내부 리마인더가 있으면 각각 all-day event로 포함한다.
- 캘린더 description에는 운영기관, 지원금, 접수 방법, 신청 상태, 담당자, 후속 메모, 공식 링크를 담아 캘린더 안에서도 맥락을 잃지 않게 한다.
- 새 외부 provider나 테이블을 만들지 않고 기존 `ApplySheet`와 `feedback.value.payload.source = application_pipeline` 데이터를 조합한다.
- DB 연결이 없거나 feedback 조회가 실패해도 공고 마감일만으로 캘린더를 생성하고, 날짜가 전혀 없을 때만 409로 응답한다.
- `/applications` 카드에는 마감일 또는 리마인더가 있는 항목에만 shadcn `buttonVariants` 기반 `캘린더` 보조 액션을 노출한다.
- Google/Microsoft 캘린더 API, 이메일/push 자동 발송은 provider 선택 이후 후속으로 남긴다.

## 16차 구현 범위

### 계정 데이터 내보내기

- `GET /api/web/account/export`를 추가해 로그인 사용자의 계정 데이터를 JSON 파일로 내려준다.
- export에는 사용자 식별 정보, 현재 회사 접근권한, 워크스페이스/팀/플랜 요약, 동의 이력, 알림 설정과 알림센터 상태, 고객지원 공개 thread, 약관/개인정보 문서 버전을 포함한다.
- 보안상 비밀번호 hash, OAuth token, refresh token, push token, 세션 token, 내부 관리자 메모, 다른 회사 멤버의 권한 밖 개인정보는 포함하지 않는다.
- `/account` hero와 문서 링크 영역에 `데이터 내보내기` 액션을 추가한다.
- `/privacy`의 사용자 권리와 문의/권리 행사 문구를 실제 export 경로와 맞춘다.
- 새 테이블이나 provider 없이 기존 계정/워크스페이스/동의/알림/고객지원 helper를 조합한다.

## 17차 구현 범위

### 계정 데이터 삭제 요청

- `POST /api/web/account/deletion-request`를 추가해 로그인 사용자의 계정/회사 데이터 삭제 또는 처리 정지 요청을 접수한다.
- 즉시 hard delete를 수행하지 않고 `support_tickets`의 `privacy` category와 `metadata.kind = account_deletion_request`로 저장해 회사 권한, 법적 보존 의무, 진행 중인 문의를 운영팀이 확인할 수 있게 한다.
- 요청자는 확인 문구 `삭제 요청`을 입력해야 하며, 접수 결과는 open 또는 queued receipt로 돌려준다.
- `/account`에 `계정 데이터 삭제 요청` 패널을 추가해 내 계정에서 데이터 export와 삭제 요청이 함께 이어지게 한다.
- 새 테이블이나 provider 없이 기존 고객지원 티켓 저장소를 재사용한다.

## 18차 구현 범위

### 회원가입 약관/개인정보 명시 동의

- `/login` 회원가입 모드에 약관/개인정보처리방침 확인 checkbox를 추가한다.
- 변경된 디자인 시스템에 맞춰 새 임의 색상이나 radius를 추가하지 않고 기존 `Checkbox`, semantic token, `tds-radius` 표면만 사용한다.
- `POST /api/web/auth/register`는 `termsAccepted`와 `privacyAccepted`가 모두 `true`일 때만 계정을 생성한다.
- `users`에 `terms_accepted_at`, `privacy_accepted_at`, `terms_version`, `privacy_version`을 추가해 계정 생성 시점의 법무 수락 이력을 저장한다.
- OAuth 또는 기존 계정 로그인처럼 회원가입 API를 거치지 않는 경로는 NextAuth sign-in 이벤트에서 누락된 법무 수락 이력을 현재 정책 버전으로 보강한다.
- 계정 데이터 export에는 현재 운영 문서 버전과 사용자별 저장된 수락 시점/수락 버전을 함께 포함한다.
- `verify:web-http`에 동의 누락 시 400을 반환하는 회귀 검증을 추가한다.

## 19차 구현 범위

### 비밀번호 재설정 흐름

- `/login`의 `비밀번호 찾기` 링크를 실제 `/forgot-password` 화면으로 연결한다.
- `POST /api/web/auth/password-reset/request`는 가입 이메일 존재 여부를 노출하지 않고 재설정 요청을 접수한다.
- 새 테이블 없이 기존 `verification_tokens`를 `password-reset:<email>` identifier와 SHA-256 token hash로 재사용한다.
- `POST /api/web/auth/password-reset/confirm`은 유효한 토큰과 새 비밀번호를 확인한 뒤 `users.password_hash`를 갱신하고 같은 이메일의 재설정 토큰을 폐기한다.
- `/reset-password?token=...`은 새 비밀번호 설정 화면을 제공하고 성공 후 로그인으로 이어지게 한다.
- 운영 이메일 provider가 없는 환경에서는 production 응답에 재설정 URL을 노출하지 않으며, 개발/검증 환경에서만 debug link를 반환할 수 있다.
- 변경된 디자인 시스템에 맞춰 기존 로그인 Brand zone 구조, shadcn `Button/Input/Alert/Field`, semantic token만 사용한다.

## 20차 구현 범위

### 계정 보안 비밀번호 변경

- `/account`에 로그인 사용자의 비밀번호 변경 패널을 추가한다.
- `PUT /api/web/account/password`는 세션 사용자의 새 비밀번호를 검증하고 `users.password_hash`를 갱신한다.
- 기존 비밀번호 hash가 있는 이메일 계정은 현재 비밀번호 확인을 요구한다.
- OAuth로만 가입해 비밀번호 hash가 없는 계정은 현재 로그인 세션을 기준으로 이메일 비밀번호를 처음 설정할 수 있다.
- 검증은 실제 비밀번호 변경 대신 짧은 새 비밀번호 validation과 `/account` 패널 렌더를 확인한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone에서 shadcn `Card`, `Field`, `Input`, `Button`, `Alert`만 사용한다.

## 21차 구현 범위

### 계정 프로필 표시 이름 수정

- `/account`에 로그인 사용자의 표시 이름을 수정하는 프로필 패널을 추가한다.
- `PUT /api/web/account/profile`은 세션 사용자의 `users.name`만 좁게 갱신한다.
- 표시 이름은 공백을 정규화하고 80자 이하로 제한하며, 빈 값은 `null`로 저장해 이메일 표시로 폴백한다.
- 계정 데이터 export는 JWT 세션 값보다 DB의 최신 사용자 이름/이메일을 우선 사용한다.
- 검증은 `/account` 패널 렌더와 긴 표시 이름 validation boundary를 확인한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone에서 shadcn `Card`, `Field`, `Input`, `Button`, `Alert`만 사용한다.

## 22차 구현 범위

### 계정 보안/세션 상태

- `/account`에 현재 세션 provider, 이메일 비밀번호 설정 여부, 약관/개인정보 수락 이력을 보여주는 보안 상태 패널을 추가한다.
- DB 또는 migration이 준비되지 않은 환경에서도 `확인 불가` 상태로 폴백해 계정 화면이 깨지지 않게 한다.
- `users.password_hash`, 법무 수락 시점/버전, 현재 운영 문서 버전을 함께 표시해 계정 관리와 개인정보 권리 행사 흐름을 연결한다.
- 세션 revoke, 기기별 접속 이력, 이메일 2FA는 별도 auth provider/세션 store 확정 이후 후속으로 남긴다.
- 검증은 `/account`에 `보안과 세션`, `법무 동의` 상태가 렌더되는지 확인한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone에서 shadcn `Card`, `Separator`, `StatusBadge`, `buttonVariants`와 semantic token만 사용한다.

## 23차 구현 범위

### 플랜 전환 요청 이력

- `/billing`에서 `support_tickets.metadata.kind = billing_plan_request`로 저장된 최근 플랜 전환 요청을 같은 화면에 노출한다.
- 새 결제 테이블이나 provider를 만들지 않고 기존 고객지원 티켓 저장소를 재사용해 접수 후 사용자 확인 흐름을 닫는다.
- 이력에는 희망 플랜, 좌석 수, 청구 주기, 접수 상태, 최근 업데이트 시각, 상담 이메일과 메시지 요약을 표시한다.
- DB 또는 migration이 준비되지 않은 환경에서는 빈 이력 상태로 폴백해 플랜 화면이 깨지지 않게 한다.
- 검증은 `/billing`에 `전환 요청 기록` 패널이 렌더되는지 확인한다.
- 디자인은 변경된 `DESIGN.md` 기준의 Work zone에서 shadcn `Card`, `StatusBadge`, semantic token만 사용한다.

## 24차 구현 범위

### 온보딩 진행 상태

- `/onboarding`이 정적인 안내만 보여주지 않고 현재 회사의 설정 완료도를 서버에서 계산해 노출한다.
- 회사 확인, 정보 동의, 자가신고 프로필, 알림 설정을 각각 `complete`, `attention`, `pending` 상태로 정규화한다.
- 회사 상태는 기존 회사 repository의 `verified`, 사업자번호 마스킹, 사업자 상태, preliminary profile을 읽어 계산한다.
- 동의 상태는 `consents` 최신 활성 scope를 기준으로 `basic_info`, `hometax`, `insurance` 3개 중 몇 개가 켜졌는지 표시한다.
- 자가신고 상태는 매출, 고용, 신청대상, 인증, 지식재산, 기수혜 같은 수기 항목과 기본 프로필 속성을 분리해 표시한다.
- 알림 상태는 기존 notification settings를 재사용하며, 마감/새 매칭 알림이 모두 꺼진 경우 다음 액션으로 안내한다.
- 새 테이블이나 API를 만들지 않고 `loadOnboardingProgress()` 서버 로더로 기존 store/repository를 읽기 전용 조합한다.
- DB 또는 외부 스토어 조회가 실패해도 기본 알림값과 빈 진행 상태로 폴백해 온보딩 화면이 깨지지 않게 한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Card`, `StatusBadge`, `buttonVariants`, semantic token만 사용한다.
- 검증은 `/onboarding`에 `온보딩 진행 상태`와 기존 `회사 데이터 연결` 패널이 함께 렌더되는지 확인한다.

## 25차 구현 범위

### 신규 사용자 첫 회사 생성 흐름

- 회사가 없는 세션 사용자가 `/dashboard`, `/applications`, `/billing`, `/team` 같은 보호 페이지에 접근하면 500으로 떨어지지 않고 `/onboarding?next=...`로 이동한다.
- `/onboarding`은 `company_access_required` 상태를 허용하고, 첫 회사 프로필 생성 패널을 렌더한다.
- 첫 회사 생성은 새 API를 만들지 않고 기존 `POST /api/web/companies`를 재사용해 현재 회사 쿠키까지 설정한다.
- 사용자는 사업자번호 10자리로 조회 기반 프로필을 만들거나, 회사명/지역/업종을 수기로 입력한 preliminary profile로 먼저 시작할 수 있다.
- 회사가 생성되면 `/onboarding`을 다시 로드해 24차의 진행 상태 카드와 기존 회사 데이터 연결 패널로 이어진다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Card`, `Alert`, `Field`, `Input`, `Select`, `Button`, `StatusBadge`, semantic token만 사용한다.
- 검증은 기존 `/onboarding` HTTP smoke와 `typecheck/build`로 기존 회사 보유 사용자의 회귀를 확인하고, 신규 회사 없음 상태는 `company_access_required` redirect 경계로 코드상 보장한다.

## 26차 구현 범위

### 공통 앱 내비게이션

- `/dashboard`, `/applications`, `/roadmap`, `/team`, `/billing`, `/settings` 앱 헤더 링크를 `appHeaderLinks()`로 공통화한다.
- `/account`와 계정 드롭다운은 같은 링크 데이터 출처를 사용해 신규 SaaS 표면이 계정 메뉴와 페이지 헤더에서 따로 누락되지 않게 한다.
- `/onboarding`은 공통 앱 링크에 고객지원 링크만 선택적으로 붙이고, 공개/법무/지원/내부 검증 콘솔 헤더는 각 페이지의 목적에 맞는 링크를 유지한다.
- 새 CSS 토큰을 추가하지 않고 기존 `ServiceHeader`, `PageNav`, `buttonVariants`, semantic token 표면을 재사용한다.
- 검증은 typecheck, route policy, web HTTP smoke, build, diff check로 헤더 링크 변경이 주요 사용자 페이지 렌더를 깨지 않는지 확인한다.

## 27차 구현 범위

### 대시보드 온보딩 진행 안내

- `/dashboard`가 매칭 결과만 보여주지 않고 현재 회사의 온보딩 완료도와 다음 보강 액션을 함께 노출한다.
- 새 API를 만들지 않고 기존 `loadOnboardingProgress()` 서버 로더를 `/dashboard` 라우트에서 재사용한다.
- 모든 온보딩 단계가 완료된 회사에는 별도 안내 카드를 렌더하지 않아 Work zone의 정보 밀도를 유지한다.
- 미완료 상태에서는 `#company-settings` 또는 `/onboarding`으로 이어지는 액션을 제공해 가입, 회사 설정, 매칭 확인 흐름을 한 화면에서 닫는다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Card`, `StatusBadge`, `buttonVariants`, semantic token만 사용하고 새 색상/radius token을 만들지 않는다.
- 검증은 `/dashboard` HTTP smoke에서 기존 설정 앵커와 함께 `설정 완료도` 렌더를 확인한다.

## 28차 구현 범위

### 온보딩 후 목적지 복귀

- 회사가 없는 사용자가 `/dashboard`, `/applications`, `/billing`, `/team` 등 보호 페이지에서 `/onboarding?next=...`로 이동한 뒤 첫 회사를 만들면 원래 목적지로 이어지게 한다.
- `next`는 `/`로 시작하고 `//`가 아닌 내부 경로만 허용하며, 그 외 값은 `/dashboard`로 폴백한다.
- 첫 회사 생성 중 세션이 만료되면 로그인 콜백도 `/onboarding?next=...`를 유지해 사용자가 다시 같은 흐름으로 돌아오게 한다.
- 기존 회사가 있는 사용자가 `/onboarding?next=...`를 열면 온보딩 진행 상태를 확인한 뒤 `이어서 진행` 또는 `나중에 하기`로 목적지에 돌아갈 수 있게 한다.
- 회사가 아직 없는 상태에서는 `나중에 하기`가 보호 페이지로 루프하지 않도록 고객지원 링크로 대체한다.
- 새 API 없이 기존 `POST /api/web/companies`, `redirectOnAuthRequired()`, `OnboardingPageView`를 연결하고, 디자인은 기존 shadcn `Button/Card` 표면만 사용한다.
- 검증은 `/onboarding?next=/applications` HTML smoke에서 복귀 액션이 렌더되는지 확인한다.

## 29차 구현 범위

### 공개 랜딩 법무/지원 링크 정합성

- 공개 랜딩 푸터의 `도입 문의`, `개인정보처리방침`, `이용약관` 링크가 로그인 화면으로 우회하지 않고 각각 `/support`, `/privacy`, `/terms`로 직접 연결되게 한다.
- 로그인하지 않은 방문자도 TOS, 개인정보 처리방침, 고객지원 창구를 즉시 확인할 수 있게 해 SaaS 공개 신뢰 흐름을 닫는다.
- 별도 UI 토큰을 추가하지 않고 기존 랜딩 푸터 구조에서 링크 목적지만 교정한다.
- 검증은 `/` HTML smoke에서 `/support`, `/privacy`, `/terms` 링크가 렌더되는지 확인한다.

## 30차 구현 범위

### 고객지원 로그인 복귀 경로

- `/support` 헤더에서 비로그인 상태의 로그인 링크가 중복 노출되지 않도록 공통 `ServiceHeader` 로그인 버튼에 맡긴다.
- 지원 페이지 헤더의 공통 로그인 버튼은 로그인 후 `/support`로 돌아오게 한다.
- hero의 `내 문의 보기` 액션은 로그인 사용자는 `/account#account-support-tickets`로 바로 이동하고, 비로그인 사용자는 로그인 후 같은 계정 문의 앵커로 돌아오게 한다.
- 새 API나 CSS를 만들지 않고 기존 `ServiceHeader.loginCallbackUrl`과 로그인 `callbackUrl` 규칙만 사용한다.
- 검증은 `/support` HTML smoke에서 계정 문의 이력 앵커 또는 그 콜백 URL이 렌더되는지 확인한다.

## 31차 구현 범위

### 고객지원 접수 후 이력 확인

- `/support`의 문의 접수 성공 상태에 접수번호만 보여주지 않고, 저장된 문의를 바로 `/account#account-support-tickets`에서 확인할 수 있는 CTA를 추가한다.
- 비로그인 방문자는 같은 계정 문의 앵커를 `callbackUrl`로 가진 로그인 링크를 사용해 로그인 후 이력 확인으로 이어지게 한다.
- DB 저장소가 연결되지 않아 `queued` receipt가 반환된 경우에는 계정 이력으로 오인되지 않도록 저장소 연결 후 운영팀 확인 문구만 보여준다.
- 새 API나 저장소를 만들지 않고 기존 `support_tickets`, `SupportTicketForm`, `/account` 문의 이력 패널을 재사용한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Button`, semantic token, 기존 16px/14px radius 표면만 사용한다.
- 검증은 typecheck, `/support` HTML smoke, web HTTP smoke, build로 지원 페이지와 문의 접수 API 회귀를 확인한다.

## 32차 구현 범위

### 지원서류 초안 추가 입력 반영

- 공고 상세 `/grants/[grantId]`의 `지원서 준비` surface가 문서별 `missingProfileFields`를 추가 입력 질문으로 보여준다.
- 사용자가 제품/서비스 설명, 지원 목표, 예산 산출근거, 대표 실적 같은 부족 항목을 입력하면 기존 `POST /api/web/grants/[grantId]/drafts`의 `answers`로 전달한다.
- core `generateDocumentDraftContent()`와 `autofillDraftFields()`의 기존 답변 반영 경로를 재사용해 새 API나 별도 저장소를 만들지 않는다.
- 초안 재생성은 기존 `grant_document_drafts` 최신 row 갱신 정책을 유지해 같은 문서의 작업 이력이 분리되지 않게 한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 shadcn `Field`, `Textarea`, `Button`, `StatusBadge`, semantic token만 사용한다.
- 검증은 typecheck, grant document draft verifier, web HTTP smoke, build, diff check로 공고 상세와 초안 API 회귀를 확인한다.

## 33차 구현 범위

### 청구 명세 Markdown 내보내기

- `/api/web/billing/statement`를 추가해 현재 회사의 플랜, 사용량, 좌석, 청구 미연동 상태, 최근 플랜 전환 요청을 Markdown 파일로 내려준다.
- 새 결제 provider나 청구 테이블을 만들지 않고 기존 `loadWorkspaceOverview()`와 `support_tickets` 기반 플랜 전환 요청 이력을 조합한다.
- `/billing` hero에 `명세서` 다운로드 액션을 추가해 결제 연동 전에도 내부 결재/검토용 문서를 확보할 수 있게 한다.
- 명세서에는 카드 정보 미수집, 청구서 미발행, 유료 전환 상담 방식 등 현재 운영 경계를 명시한다.
- 다운로드 응답은 기존 `markdownDownloadResponse()`의 UTF-8 파일명/ASCII fallback 헤더를 재사용한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 shadcn `buttonVariants`, semantic token 표면만 사용하고 새 CSS를 추가하지 않는다.
- 검증은 route policy, typecheck, web HTTP smoke, build, diff check로 청구 화면과 다운로드 API 회귀를 확인한다.

## 34차 구현 범위

### 신청 파이프라인 리포트 Markdown 내보내기

- `/api/web/applications/report`를 추가해 현재 회사의 신청 파이프라인 단계별 건수, 다음 액션, 단계별 상세 목록을 Markdown 파일로 내려준다.
- 새 테이블이나 외부 provider를 만들지 않고 기존 `loadServiceDashboard()`와 `buildApplicationPipeline()` 결과를 재사용한다.
- `/applications` hero에 `리포트` 다운로드 액션을 추가해 팀 내부 주간 점검이나 대표 보고에 바로 쓸 수 있게 한다.
- 리포트에는 담당자, 리마인더, 결과/후속 메모, 초안 검토 수, 지원금/기관/마감 상태를 포함한다.
- 다운로드 응답은 기존 `markdownDownloadResponse()`의 UTF-8 파일명/ASCII fallback 헤더를 재사용한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 shadcn `buttonVariants`, semantic token 표면만 사용하고 새 CSS를 추가하지 않는다.
- 검증은 route policy, typecheck, web HTTP smoke, build, diff check로 신청 보드와 다운로드 API 회귀를 확인한다.

## 35차 구현 범위

### 고객지원 문의 기록 Markdown 내보내기

- `/api/web/support/tickets/[ticketId]/transcript`를 추가해 사용자가 접근 가능한 문의의 공개 대화 기록을 Markdown 파일로 내려준다.
- 새 저장소를 만들지 않고 기존 `support_tickets`와 `support_ticket_messages`의 public 메시지만 조합한다.
- 내부 운영 메모, 관리자 담당자, 비공개 메타데이터는 transcript에 포함하지 않는다.
- `/account#account-support-tickets`의 각 문의 row에 `대화 내려받기` 액션을 추가해 문의 처리 이력을 사용자가 직접 보관할 수 있게 한다.
- 다운로드 응답은 기존 `markdownDownloadResponse()`의 UTF-8 파일명/ASCII fallback 헤더를 재사용한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 shadcn `buttonVariants`, semantic token 표면만 사용하고 새 CSS를 추가하지 않는다.
- 검증은 route policy, typecheck, web HTTP smoke, build, diff check로 계정 문의 패널과 다운로드 API 회귀를 확인한다.

## 36차 구현 범위

### 신청 보드 패키지 내보내기

- `/applications`의 각 신청 카드에서 `/api/web/grants/[grantId]/package` Markdown 패키지를 바로 내려받을 수 있게 한다.
- 사용자가 공고 상세로 다시 들어가지 않아도 정규화 제출서류, 보관 첨부 링크, 추가 입력 질문, 저장된 AI 초안을 한 번에 확보할 수 있게 해 신청 관리 보드의 산출물 흐름을 닫는다.
- 새 API나 스타일을 만들지 않고 기존 `buildGrantApplicationPackage()`, `buttonVariants`, `Download` 아이콘을 재사용한다.
- 검증은 `/applications` HTML smoke에서 패키지 링크를 확인하고, 패키지 API가 Markdown attachment와 제출서류 taxonomy 본문을 반환하는지 확인한다.

## 37차 구현 범위

### 운영 법무 고지 설정화

- `legalConfig`에 통신판매업 신고번호, 개인정보 수탁사, 국외이전 항목을 환경값 기반 구조로 추가한다.
- `/terms`는 운영자 정보 섹션에서 운영자, 문의처, 사업자등록번호, 통신판매업 신고번호, 주소를 같은 설정 출처로 표시한다.
- `/privacy`는 개인정보보호책임자, 수탁사 목록, 국외이전 목록을 명시하고, 미설정 환경에서는 운영 환경 설정 전임을 분명히 표시한다.
- `GET /api/web/account/export`의 `legal` 객체에도 같은 운영 법무 필드를 포함해 사용자가 계정 데이터 export 시점의 법무 고지 상태를 보관할 수 있게 한다.
- 새 UI 스타일이나 저장소 없이 기존 `LegalPage`, `getLegalConfig()`, 계정 export JSON 구조를 확장한다.
- 검증은 `/terms`, `/privacy`, 계정 export HTTP smoke에서 운영자/책임자/수탁사/국외이전 필드가 렌더되고 export되는지 확인한다.

## 38차 구현 범위

### 신청 리마인더 인앱 알림

- `/applications`에서 저장한 `feedback.value.payload.source = application_pipeline` 리마인더를 알림센터의 deadline 계열 알림으로 합성한다.
- 외부 이메일/push provider 없이도 dashboard/account 알림센터에서 오늘/다가오는/지난 내부 리마인더를 확인할 수 있게 한다.
- runtime adapter에서도 HTTP smoke가 같은 흐름을 검증할 수 있도록 파이프라인 관리 payload를 서버 메모리에 보조 기록하고, DB 모드에서는 기존 feedback 저장소를 계속 우선 사용한다.
- 캘린더 export도 같은 runtime 보조 기록을 읽어 로컬/sample 환경에서 신청 리마인더 이벤트가 누락되지 않게 한다.
- 새 알림 kind나 UI 스타일을 추가하지 않고 기존 `deadlineReminder` 설정, `NotificationFeedPanel`, `buttonVariants`/카드 표면을 그대로 재사용한다.
- 검증은 feedback API에 리마인더 payload를 저장한 뒤 `/api/web/notification-feed`가 `application_reminder:*` 알림을 반환하고, `/api/web/applications/[grantId]/calendar`가 `리마인더` 이벤트를 포함하는지 확인한다.

## 39차 구현 범위

### 지원서 초안 인쇄용 HTML 내보내기

- 기존 `GET /api/web/document-drafts/[draftId]/download`에 `?format=html`을 추가해 저장된 AI 초안을 standalone HTML attachment로 내려준다.
- HTML export는 heading, bullet list, markdown table을 인쇄 가능한 문서 구조로 변환하고, 사용자 편집 본문은 escape 처리해 script가 실행되지 않게 한다.
- `/grants/[grantId]`의 AI 초안 액션에는 기존 Markdown 외에 `인쇄용 HTML` 버튼을 추가하고, 다운로드 전 현재 편집 본문을 저장한 뒤 draft status를 `exported`로 갱신한다.
- DOCX/PDF provider 또는 외부 변환기는 아직 붙이지 않고, 브라우저 인쇄/PDF 저장이 가능한 중간 산출물을 먼저 제공한다.
- 검증은 `verify:document-draft-html-export`, typecheck, route policy, build, diff check로 확인한다.

## 40차 구현 범위

### 팀 권한 변경 이력

- `team_role_change_events`를 추가해 회사별 멤버 역할 변경의 대상자, 변경 전/후 역할, 실행자, 실행 시각을 감사 로그로 보관한다.
- 사용자가 탈퇴하거나 이름/이메일이 바뀌어도 과거 로그가 읽히도록 대상자와 실행자의 이름/이메일 스냅샷을 함께 저장한다.
- `updateTeamMemberRole()`은 역할 변경과 감사 이벤트 생성을 같은 DB 사용자 컨텍스트에서 처리하고, API 응답에는 방금 생성된 이벤트를 포함해 UI가 즉시 갱신되게 한다.
- `loadWorkspaceOverview()`는 최근 권한 변경 이벤트를 팀 화면에 함께 싣고, `/team`의 기존 `TeamManagementPanel`은 관리자에게 권한 변경 이력과 빈 상태를 보여준다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 `workspace-panel`, `StatusBadge`, semantic token, 16px/14px radius 표면만 사용한다.
- 검증은 DB migration verifier, typecheck, route policy, web HTTP smoke, build, diff check로 팀 화면과 API 회귀를 확인한다.

## 41차 구현 범위

### 신청 첨부 묶음 Manifest

- 기존 `GET /api/web/grants/[grantId]/package`에 `?format=attachments`를 추가해 원문 첨부, R2 보관본, 변환 Markdown, 연결 제출서류를 Markdown manifest로 내려준다.
- 새 저장소나 파일 압축 provider 없이 기존 `loadServiceApplySheet()`의 `sourceAttachments`, 제출서류 taxonomy, 첨부 연결 정보를 재사용한다.
- `/grants/[grantId]`의 지원서 준비 surface에는 `첨부 묶음` 액션을 추가해 전체 신청 패키지와 별도로 첨부 점검 manifest를 받을 수 있게 한다.
- 준비 서류 카드에서는 첨부별 `보관본`, `원문`, `Markdown` 링크를 분리해 R2 업로드본과 변환 markdown에 바로 접근할 수 있게 한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 `buttonVariants`, `StatusBadge`, document 카드 표면과 semantic token만 사용한다.
- 검증은 web HTTP smoke에서 attachment manifest 응답과 공고 상세 버튼 렌더를 확인하고, typecheck, route policy, build, diff check로 회귀를 확인한다.

## 42차 구현 범위

### 원문 양식 필드 매핑 노출

- 기존 `grant_document_fields`를 읽는 `listGrantDocumentFormFields()` projection helper를 추가해 저장된 원문 양식 항목, 섹션, 필드 유형, 필수 여부, 자동채움 전략, 근거 문구를 화면과 export에서 재사용한다.
- `/grants/[grantId]`는 저장된 공고의 양식 필드 매핑을 `ApplySheetView`에 함께 전달하고, 샘플/미저장 공고나 DB 미연결 환경에서는 빈 상태로 안전하게 degrade한다.
- 지원서 준비 surface에는 `원문 양식 필드 매핑` 패널을 추가해 사용자가 AI 초안 작성 전에 어떤 양식 항목이 프로필 복사, AI 작성, 사용자 입력, 수동 확인 대상인지 볼 수 있게 한다.
- 전체 신청 패키지와 첨부 묶음 manifest에도 `원문 양식 필드 매핑` 섹션을 포함해 내려받은 산출물만으로 양식 작성 항목을 점검할 수 있게 한다.
- 새 테이블이나 외부 provider 없이 기존 `grant_document_fields`, `loadServiceApplySheet()`, shadcn `Table`, `StatusBadge`, semantic token만 사용한다.
- 검증은 web HTTP smoke에서 패키지/첨부 manifest/공고 상세 HTML의 필드 매핑 섹션을 확인하고, typecheck, route policy, build, diff check로 회귀를 확인한다.

## 43차 구현 범위

### 청구 준비도와 provider 전환 상태

- `/billing`에 청구 준비도 surface를 추가해 사업자 확인, 좌석 사용량, 플랜 전환 요청, 청구 연락처, 운영 법무 정보, 결제 provider 연동 상태를 한 번에 확인하게 한다.
- 새 결제 테이블이나 provider 구현을 만들지 않고 기존 `loadWorkspaceOverview()`, `support_tickets` 기반 플랜 전환 요청 이력, `getLegalConfig()`를 조합해 서버에서 상태를 파생한다.
- 결제 provider는 `CUNOTE_BILLING_PROVIDER`, `TOSS_PAYMENTS_SECRET_KEY`, `STRIPE_SECRET_KEY` 환경값 감지로만 표시하고, 미연동 상태에서는 카드/계좌 자동 결제와 영수증 발행이 비활성임을 명확히 둔다.
- 청구 명세서 Markdown에도 같은 준비도 섹션을 넣어 사용자가 다운로드한 산출물만으로 유료 전환 체크 상태를 공유할 수 있게 한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 `workspace-panel`, `StatusBadge`, semantic token, 16px/14px radius 표면만 사용한다.
- 검증은 web HTTP smoke에서 `/billing` HTML과 `/api/web/billing/statement`의 준비도 섹션을 확인하고, typecheck, route policy, build, diff check로 회귀를 확인한다.

## 44차 구현 범위

### 고객지원 SLA 인앱 알림

- `support_tickets.metadata.slaDueAt`을 알림센터의 `needs_input` 알림으로 합성해 사용자가 `/account#account-support-tickets`에서 응답 기준일이 다가오거나 지난 문의를 바로 확인하게 한다.
- 새 알림 kind, 새 테이블, 외부 provider를 추가하지 않고 기존 `NotificationCenterResult`, 알림 receipt 읽음/숨김 상태, 고객지원 티켓 저장소를 재사용한다.
- `resolved`, `closed`, `waiting` 상태의 티켓은 제외하고 `open`, `in_progress` 같은 운영 응답이 필요한 티켓만 D-day 기준으로 노출한다.
- SLA 기준일이 오늘이거나 지난 경우 high, 2일 이내 medium, 7일 이내 low 우선순위로 정렬해 기존 알림센터의 밀도와 우선순위를 유지한다.
- 변경된 디자인 시스템에서는 새 UI 토큰을 만들지 않고 기존 `NotificationFeedPanel`과 `/account` 문의 이력 surface가 알림 target을 그대로 처리한다.
- 검증은 admin support ticket 업데이트 smoke에서 가까운 SLA 날짜를 저장한 뒤 `/api/web/notification-feed`가 `support_sla:*` 알림을 반환하는지 확인한다.

## 45차 구현 범위

### 지원서 초안 DOCX 내보내기

- 기존 `GET /api/web/document-drafts/[draftId]/download`에 `?format=docx`를 추가해 저장된 AI 초안을 Word 호환 DOCX attachment로 내려준다.
- 새 외부 변환 provider나 런타임 의존성을 추가하지 않고 서버에서 최소 OpenXML 패키지를 생성해 Markdown 제목, 목록, 표, 자동채움 값, 상태/수정 시각 metadata를 포함한다.
- Markdown/HTML export와 같은 권한 경계, 파일명 sanitize, UTF-8 `Content-Disposition` fallback을 재사용한다.
- `/grants/[grantId]`의 초안 작업영역에는 기존 shadcn `Button` 패턴으로 `DOCX` 보조 액션을 추가하고, 다운로드 전 현재 편집 내용과 자동채움 값을 저장한다.
- DOCX는 제출 최종본이 아니라 팀 공유/수정용 작업 초안임을 유지하며, 원문 양식 완전 재현이나 PDF 생성은 후속 provider 고도화 범위로 남긴다.
- 검증은 document draft export verifier에서 DOCX zip package, `word/document.xml`, XML escape, 자동채움 값 포함 여부를 확인한다.

## 46차 구현 범위

### 신청 보드 통합 캘린더 내보내기

- `/api/web/applications/calendar`를 추가해 신청 보드의 모든 활성 공고 마감일과 내부 리마인더를 하나의 `.ics` 파일로 내려준다.
- 새 외부 캘린더 provider를 붙이지 않고 기존 `loadServiceDashboard()`와 `buildApplicationPipeline()` 결과만 사용해 API 호출과 공고별 상세 조회를 늘리지 않는다.
- `dismissed` 단계는 제외하고 추천, 저장, 서류 준비, 제출, 선정/탈락/막힘 단계의 마감일과 리마인더를 포함한다.
- 각 이벤트 description에는 운영기관, 지원금, 신청 단계, 적합도, 담당자, 후속 메모, 창업노트 상세 링크를 넣어 외부 캘린더에서도 맥락을 잃지 않게 한다.
- `/applications` hero에는 기존 shadcn `buttonVariants` 패턴으로 `전체 캘린더` 보조 액션을 추가한다.
- Google/Microsoft Calendar API 양방향 동기화, 팀 담당자별 초대, 이메일/push reminder는 후속 provider 연동 범위로 남긴다.
- 검증은 `/applications` HTML smoke에서 통합 캘린더 링크를 확인하고, `/api/web/applications/calendar`가 `text/calendar` attachment와 `VEVENT`를 반환하는지 확인한다.

## 47차 구현 범위

### 계정 삭제 요청 이력 확인

- `POST /api/web/account/deletion-request`로 접수한 `support_tickets.metadata.kind = account_deletion_request` 요청을 `/account`에서 최근 이력으로 다시 보여준다.
- 새 개인정보 요청 테이블을 만들지 않고 기존 `support_tickets`의 `privacy` category와 metadata를 projection해 접수 후 새로고침해도 사용자가 처리 상태를 확인할 수 있게 한다.
- 이력 조회는 현재 회사와 요청 사용자/세션 이메일 범위로 제한해 다른 멤버의 개인정보 요청이 계정 화면에 섞이지 않게 한다.
- 계정 데이터 export에도 `deletionRequests` 배열을 포함해 사용자가 개인정보 권리 행사 이력을 함께 보관할 수 있게 한다.
- DB 또는 migration이 준비되지 않은 환경에서는 빈 이력 상태로 폴백하고, 접수 API는 기존 queued receipt 흐름을 유지한다.
- 디자인은 변경된 `DESIGN.md` 기준으로 기존 `Card`, `StatusBadge`, semantic token, 16px/14px radius 표면만 사용한다.
- 검증은 `/account` HTML에서 최근 삭제 요청 섹션을 확인하고, 계정 export JSON에 `deletionRequests`가 포함되며, 삭제 요청 정상 접수 API가 201 또는 202를 반환하는지 확인한다.

## 48차 구현 범위

### 계정 데이터 export 청구 요청 이력

- `GET /api/web/account/export`에 `billingPlanRequests` 배열을 포함해 사용자가 플랜 전환 상담 요청 이력까지 계정 데이터와 함께 보관할 수 있게 한다.
- 새 청구 테이블이나 provider를 만들지 않고 기존 `support_tickets.metadata.kind = billing_plan_request` projection인 `listBillingPlanRequestHistory()`를 재사용한다.
- `/billing` 화면의 전환 요청 기록과 계정 export가 같은 데이터 출처를 쓰게 해 사용자 화면과 권리 행사 산출물의 정합성을 유지한다.
- DB 또는 migration이 준비되지 않은 환경에서는 빈 배열로 폴백해 export가 실패하지 않게 한다.
- 검증은 web HTTP smoke에서 account export JSON에 `billingPlanRequests` 배열이 포함되는지 확인한다.

## 49차 구현 범위

### 결제 provider 전 구독 상태 모델

- `billingSubscription` 서버 snapshot을 추가해 현재 플랜명, 구독 상태, provider 설정, 자동결제/청구서/결제수단 관리 여부, 좌석 한도를 한 출처에서 읽는다.
- 새 결제 테이블이나 provider webhook을 만들기 전까지 `CUNOTE_BILLING_*`, `TOSS_PAYMENTS_SECRET_KEY`, `STRIPE_SECRET_KEY` 환경값으로 운영 상태를 표시하고, 미설정 환경은 Early Access 기본값으로 폴백한다.
- `loadWorkspaceOverview()`가 고정 Early Access 문자열 대신 snapshot을 사용해 `/billing`, 좌석 한도, 사용량, 워크스페이스 export가 같은 플랜 상태를 공유하게 한다.
- `/billing`은 기존 `Card`, `StatusBadge`, `billing-state-list` 표면만 재사용해 구독 상태와 provider 출처를 보여주며 새 CSS 토큰을 추가하지 않는다.
- 청구 명세 Markdown과 계정 데이터 export에도 같은 `billingSubscription`을 포함해 사용자가 export 시점의 청구/구독 상태를 보관할 수 있게 한다.
- 실제 provider webhook, 구독 write table, 카드/계좌 등록, 영수증 발행은 후속 결제 provider 연동 범위로 남긴다.
- 검증은 web HTTP smoke에서 `/billing`, `/api/web/billing/statement`, `/api/web/account/export`가 구독 상태를 포함하는지 확인한다.

## 50차 구현 범위

### 구독 상태 write path와 운영 갱신 API

- `billing_subscriptions` 테이블을 추가해 회사별 현재 구독 상태, provider, provider 고객/구독 id, 플랜명, 가격/갱신 라벨, 좌석 한도, 자동결제/청구서/결제수단 관리 여부를 저장한다.
- `loadBillingSubscriptionSnapshot()`은 DB 저장 row를 우선 읽고, DB/migration 미준비 또는 demo 환경에서는 49차의 환경값/Early Access snapshot으로 폴백한다.
- `PATCH /api/admin/flywheel/billing-subscriptions/[companyId]`를 추가해 운영자가 provider webhook 연결 전에도 구독 상태를 수동 갱신할 수 있게 한다.
- admin write path는 `requireAdminAccess()`로 보호하고, DB가 없는 환경에서는 `persisted: false` 202 응답으로 화면/API 흐름이 깨지지 않게 한다.
- admin flywheel surface와 `/api/admin/status`에 `billing_subscriptions`를 추가해 운영 콘솔에서 최근 구독 상태를 확인할 수 있게 한다.
- `/billing`, 청구 명세, 계정 export는 같은 `WorkspaceOverview.billingSubscription`을 재사용하므로 저장 row가 생기면 사용자 화면과 export에 즉시 같은 상태가 반영된다.
- 실제 Toss/Stripe webhook signature 검증, 결제수단 등록, 영수증/세금계산서 발행, 좌석 과금 자동화는 후속 provider 연동 범위로 남긴다.
- 검증은 admin route guard, DB migration verifier, web HTTP smoke의 admin PATCH 200/202 또는 403 boundary, typecheck/build로 확인한다.

## 51차 구현 범위

### Signed billing webhook intake

- `billing_webhook_events` 테이블을 추가해 provider, event id/type, 회사 id, provider customer/subscription id, signature 검증 여부, 처리 상태, raw payload를 보관한다.
- `POST /api/web/billing/webhook/[provider]`를 공개 signed endpoint로 추가하고, `CUNOTE_BILLING_WEBHOOK_SECRET` 또는 provider별 `*_WEBHOOK_SECRET`이 없으면 503으로 닫는다.
- 기본 서명은 `x-cunote-signature: sha256=<hex>` HMAC-SHA256 raw body로 검증하고, Stripe 호환 `stripe-signature`의 `t`/`v1` 형식도 같은 secret으로 검증할 수 있게 한다.
- 검증된 event payload에서 `companyId`, subscription/customer id, status, plan, 좌석 한도, provider portal, period/trial 날짜를 정규화해 50차 `billing_subscriptions` 저장소에 반영한다.
- 중복 provider/event id는 다시 저장하지 않고 duplicate 처리해 provider 재시도에도 같은 event가 여러 번 쌓이지 않게 한다.
- admin flywheel과 `/api/admin/status`에 `billing_webhook_events` surface를 추가해 운영자가 최근 수신/처리 상태를 볼 수 있게 한다.
- 실제 Toss/Stripe 제품별 event schema 전체 매핑, 결제수단 등록 UI, 영수증/세금계산서 파일 보관, 좌석 사용량에 따른 자동 과금은 후속 provider 고도화로 남긴다.
- 검증은 route policy, admin route guard, DB migration verifier, web HTTP smoke의 unsigned webhook 401/503 boundary, typecheck/build로 확인한다.

## 52차 구현 범위

### 청구/영수증 archive projection

- `billing_invoices` 테이블을 추가해 provider 청구서 id, 청구번호, 상태, 통화, 청구/결제/세금 금액, 원본 청구서 URL, 영수증 URL, 발행/결제/서비스 기간, raw payload를 회사 단위로 보관한다.
- signed billing webhook 정규화 단계에서 invoice/receipt 신호가 있는 event를 `billing_invoices`에 upsert해 webhook 수신 이벤트와 사용자-facing 청구 이력을 분리한다.
- `/billing`에 `청구/영수증 기록` 패널을 추가해 최근 청구 금액, 상태, provider, 원본 링크, Markdown 영수증 다운로드를 표시한다.
- `GET /api/web/billing/invoices/[invoiceId]/receipt`를 추가해 현재 회사에 속한 청구 이력만 Markdown 영수증으로 내려준다.
- 청구 명세 Markdown과 계정 데이터 export에 `billingInvoices`를 포함해 다운로드 산출물에서도 같은 청구 이력을 보관할 수 있게 한다.
- admin flywheel과 `/api/admin/status`에 `billing_invoices` surface를 추가해 운영자가 최근 청구 projection을 확인할 수 있게 한다.
- 실제 PG사별 세금계산서 원본 보관, 결제수단 포털 deep link, 환불/부분 결제/크레딧 노트 상세 매핑은 후속 provider 고도화로 남긴다.
- 검증은 route policy, admin route guard, DB migration verifier, web HTTP smoke의 `/billing`/명세서/account export assertion, typecheck/build로 확인한다.

## 53차 구현 범위

### 결제수단 archive projection

- `billing_payment_methods` 테이블을 추가해 provider 결제수단 id, customer id, 타입, 브랜드, last4, 만료월/연도, 기본 결제수단 여부, 상태, provider 포털 URL, last used 시각을 회사 단위로 보관한다.
- 전체 카드번호, CVC, provider secret/token은 저장하지 않고, raw payload도 민감 결제 키를 redaction한 뒤 디버깅용으로만 보관한다.
- signed billing webhook 정규화 단계에서 payment method 신호가 있는 event를 `billing_payment_methods`에 upsert하고, payment method-only event가 구독 상태를 잘못 덮어쓰지 않도록 subscription/invoice/payment_method 신호를 분리한다.
- `/billing`에 `결제수단 기록` 패널을 추가해 등록된 결제수단의 표시명, 상태, 기본 여부, 만료 정보, provider 포털 링크를 보여준다.
- 청구 명세 Markdown과 계정 데이터 export에 `billingPaymentMethods`를 포함해 사용자가 export 시점의 결제수단 연결 상태를 보관할 수 있게 한다.
- admin flywheel과 `/api/admin/status`에 `billing_payment_methods` surface를 추가해 운영자가 최근 결제수단 projection을 확인할 수 있게 한다.
- 실제 카드 등록 UI, PG사 billing key 생성, 세금계산서 원본 보관, 환불/크레딧 노트 상세 매핑은 후속 provider 고도화로 남긴다.
- 검증은 admin route guard, DB migration verifier, web HTTP smoke의 `/billing`/명세서/account export assertion, typecheck/build로 확인한다.

## 54차 구현 범위

### 청구 담당자와 세금계산서 수신 프로필

- `billing_tax_profiles` 테이블을 추가해 회사별 상호/법인명, 사업자등록번호, 청구 담당자, 담당자 이메일/전화, 세금계산서 수신 이메일, 사업장 주소, 수신 여부, 청구 메모를 저장한다.
- `/api/web/billing/tax-profile` PUT route를 추가해 회사 write 권한이 있는 사용자만 청구 프로필을 수정할 수 있게 한다.
- DB 미연결 또는 demo 환경에서는 `persisted: false` 응답으로 화면 흐름을 유지하고, 조회는 회사명/사업자번호/세션 이메일 기반 기본값으로 안전하게 폴백한다.
- `/billing`에 `청구 프로필` 패널과 저장 폼을 추가해 실제 provider 연결 전에도 세금계산서/내부 결재에 필요한 수신 정보를 준비할 수 있게 한다.
- 화면과 export에는 사업자등록번호를 마스킹해서 표시하고, 원문 번호는 저장 용도로만 사용한다.
- 청구 명세 Markdown과 계정 데이터 export에 `billingTaxProfile`을 포함해 사용자가 export 시점의 청구 수신 정보를 보관할 수 있게 한다.
- admin flywheel과 `/api/admin/status`에 `billing_tax_profiles` surface를 추가해 운영자가 최근 청구 프로필 설정 상태를 확인할 수 있게 한다.
- 실제 PG사 세금계산서 발행, 전자세금계산서 파일 보관, 사업자등록증 첨부 검증은 후속 provider 고도화로 남긴다.
- 검증은 route policy, admin route guard, DB migration verifier, web HTTP smoke의 저장 API/`/billing`/명세서/account export assertion, typecheck/build로 확인한다.

## 55차 구현 범위

### 청구 증빙 파일 아카이브

- `billing_tax_documents` 테이블을 추가해 회사별 사업자등록증, 통장사본, 전자세금계산서 관련 증빙, 기타 청구 증빙 파일의 R2 보관 URL, storage key, content type, byte size, sha256, 업로드 사용자, 상태를 저장한다.
- `POST /api/web/billing/tax-documents`를 추가해 회사 write 권한이 있는 사용자가 multipart 파일을 업로드할 수 있게 한다.
- 업로드는 `createR2ObjectStorageFromEnv()`를 재사용하고, R2 설정이 없는 환경에서는 `persisted: false` 202 응답으로 화면 흐름을 유지한다.
- `DELETE /api/web/billing/tax-documents/[documentId]`는 파일 원본을 즉시 삭제하지 않고 DB 상태를 `archived`로 바꿔 잘못 올린 증빙을 사용자 화면에서 숨긴다.
- `/billing`에 `청구 증빙 파일` 패널을 추가해 최근 업로드 파일, 문서 종류, 크기, R2 보관 링크, 보관 해제 액션을 보여준다.
- 청구 명세 Markdown과 계정 데이터 export에 `billingTaxDocuments`를 포함해 내부 결재/권리 행사 산출물에서도 같은 증빙 보관 상태를 확인할 수 있게 한다.
- admin flywheel과 `/api/admin/status`에 `billing_tax_documents` surface를 추가해 운영자가 최근 증빙 업로드 상태를 볼 수 있게 한다.
- 실제 PG사 세금계산서 발행 API, 파일 바이러스 스캔, 원본 삭제 retention job은 후속 provider/보안 고도화 범위로 남긴다.
- 검증은 route policy, admin route guard, DB migration verifier, web HTTP smoke의 `/billing`/명세서/account export/업로드 fallback assertion, typecheck/build로 확인한다.

## 56차 구현 범위

### 고객지원 첨부 파일 아카이브

- `support_ticket_attachments` 테이블을 추가해 고객지원 티켓별 스크린샷, 오류 로그, 문서 파일의 R2 보관 URL, storage key, content type, byte size, sha256, 공개/내부 visibility, 상태를 저장한다.
- `POST /api/web/support/tickets/[ticketId]/attachments`를 추가해 티켓 접수 이메일, 세션 사용자, 회사 접근권한 중 하나로 접근이 확인된 경우에만 첨부를 업로드한다.
- `/support` 문의 폼에 선택 파일 1개를 추가하고, 티켓이 저장된 경우 이어서 첨부 업로드를 시도한다. DB 또는 R2 미설정 환경에서는 티켓 접수 흐름을 깨지 않고 첨부 보관 안내만 표시한다.
- `/account` 내 문의 기록과 문의 transcript Markdown에 공개 첨부 파일 목록과 보관 링크를 포함한다.
- `/admin` 고객지원 패널에는 티켓별 첨부 개수와 최근 첨부 파일명을 표시해 운영자가 재현 자료가 있는 문의를 바로 구분할 수 있게 한다.
- 계정 데이터 export의 `supportTickets` 항목에 공개 첨부 metadata를 포함해 사용자가 문의와 함께 제출한 파일 보관 상태를 확인할 수 있게 한다.
- 새 파일 삭제는 원본 삭제가 아니라 `archived` 상태 전환으로 처리하고, 바이러스 스캔/원본 삭제 retention job/다중 파일 업로드는 후속 보안 고도화 범위로 남긴다.
- 검증은 route policy, DB migration verifier, web HTTP smoke의 support form HTML/첨부 업로드 fallback/transcript/account export/admin HTML assertion, typecheck/build로 확인한다.

## 57차 구현 범위

### 고객지원 첨부 보관 해제

- 56차에서 추가한 `support_ticket_attachments`의 원본 R2 객체는 삭제하지 않고 DB `status`만 `archived`로 바꾸는 보관 해제 write path를 추가한다.
- `DELETE /api/web/support/tickets/[ticketId]/attachments/[attachmentId]`는 로그인 사용자의 회사 접근권한/세션 이메일이 티켓과 맞는 경우에만 실행한다.
- `/account`의 고객지원 기록에서 공개 첨부 파일 옆에 보관 해제 버튼을 제공하고, 성공 시 현재 화면 목록에서 즉시 제거한다.
- 기존 `listSupportTicketAttachmentsForTickets()` 기본 조회는 active만 반환하므로 transcript, 계정 export, 계정 화면에서 archived 첨부가 자연스럽게 제외된다.
- 실제 원본 삭제, retention job, 바이러스 스캔, 관리자 bulk 보관 해제는 후속 보안/운영 고도화 범위로 남긴다.
- 검증은 route policy, web HTTP smoke의 invalid boundary, typecheck, build, diff check로 확인한다.

## 58차 구현 범위

### 운영 법무 readiness

- `getLegalConfig()`를 환경값 주입 가능하게 확장하고, 실제 운영 배포에 필요한 법무 고지 항목이 기본값인지 확정값인지 판정하는 `buildLegalReadiness()` helper를 추가한다.
- readiness는 운영자명, 고객지원 이메일, 개인정보 문의처, 사업자등록번호/주소, 통신판매업 신고번호, 정책 시행일/버전, 보유 기간, 수탁사/국외이전 환경값을 항목별로 점검한다.
- `/api/admin/status`의 `runtime.legalReadiness`에 score, 누락 env key, 항목 상태를 포함하고 `legal_readiness` surface를 추가한다.
- `/admin` 실행 구성 패널에는 legal readiness 점수와 누락 env key를 표시해 배포 전 공개 법무 고지 상태를 한 화면에서 확인하게 한다.
- 공개 약관/개인정보/계정 export는 기존 `getLegalConfig()` 출처를 유지하므로 env 값이 확정되면 사용자-facing 문서와 admin readiness가 같은 설정을 반영한다.
- 검증은 web HTTP smoke의 `/api/admin/status`와 `/admin` assertion, typecheck, route policy, build, diff check로 확인한다.

## 59차 구현 범위

### 지원서 초안 품질 피드백 루프

- `POST /api/web/document-drafts/[draftId]/feedback`을 추가해 사용자가 초안별 사실 오류, 맥락 부족, 양식 불일치, 일반적 내용, 기타 피드백을 남길 수 있게 한다.
- 새 테이블을 만들지 않고 기존 `grant_document_draft_events`에 `quality_feedback` 이벤트를 저장해 초안 생성/수정/export 이벤트와 같은 품질 로그 stream으로 집계할 수 있게 한다.
- 피드백 이벤트 payload에는 유형, 사용자 메모, 선택 문항/본문, 문서명, 문서 category, draft/model/prompt/parser version을 포함해 이후 hallucination report/manual correction count와 템플릿 개선에 연결한다.
- 공고 상세 `DocumentDraftWorkspace`에는 변경된 `DESIGN.md` 기준으로 shadcn `Select`, `Textarea`, `Button`만 사용한 `초안 품질 피드백` 패널을 추가한다.
- HTTP smoke는 invalid draft id boundary를 검증하고, DB persistence verifier는 실제 draft 생성 후 `quality_feedback` 이벤트가 저장되는지 확인한다.

## 60차 구현 범위

### 고객지원 운영 답변 알림

- 운영자가 `support_ticket_messages`에 공개 답변을 남기면 해당 티켓이 `waiting` 상태가 되므로, 이 상태의 최신 공개 admin 메시지를 알림센터의 `needs_input` 항목으로 합성한다.
- 새 알림 kind, 테이블, 외부 이메일/Slack provider를 만들지 않고 기존 `NotificationCenterResult`, `notification_receipts`, `/account#account-support-tickets` 흐름을 재사용한다.
- 알림 ID는 `support_reply:{ticketId}:{messageId}`로 안정화해 사용자가 읽음/숨김 처리한 상태가 기존 receipt 저장소에 그대로 남게 한다.
- 현재 변경된 `DESIGN.md`/`design-tokens.json` 기준에서는 새 UI를 추가하지 않고 shadcn `Card`/`Button` 기반 기존 알림 패널에 데이터만 공급해 Work zone의 정보 밀도를 유지한다.
- HTTP smoke는 admin 공개 답변 저장 직후 `/api/web/notification-feed`가 `support_reply:*` 알림을 반환하는지 확인한다.

## 61차 구현 범위

### App 알림 feed parity

- `/api/app/v1/companies/[companyId]/notifications`가 core의 매칭 원시 feed만 반환하던 구조를 웹 알림센터와 같은 서버 합성 로직으로 교체한다.
- app API 응답은 기존 `NotificationFeedResult` contract를 유지해 `generatedAt`과 `notifications[]`만 반환하고, 웹 전용 `href`, `status`, `readAt`, `dismissedAt`, `settings` 필드는 노출하지 않는다. 앱 feed는 화면 패널보다 넓은 40개 limit으로 요청해 리마인더가 카드형 패널 limit에 밀려 누락되지 않게 한다.
- 이 변경으로 app 클라이언트도 마감/새 매칭뿐 아니라 신청 리마인더, 고객지원 SLA, 운영 답변 입력 필요 알림을 같은 정렬/설정 규칙으로 받을 수 있다.
- app match feedback route도 웹과 동일하게 `recordApplicationManagementFeedback()`을 호출해 앱에서 저장한 신청 상태/리마인더가 신청 보드와 알림센터에 반영되게 한다.
- app 접근권한에는 UI role이 없으므로 읽기 전용 `viewer` access로 알림센터를 호출하고, 쓰기/receipt 처리는 기존 web receipt endpoint에 한정한다.
- 외부 push/email 발송과 모바일 push token fanout은 후속 provider 연동 범위로 남긴다.

## 62차 구현 범위

### App 알림 읽음/숨김 receipt

- `POST /api/app/v1/companies/[companyId]/notifications/receipt`를 추가해 앱 클라이언트도 알림을 `read` 또는 `dismissed` 상태로 저장할 수 있게 한다.
- 저장소는 웹 알림센터와 같은 `updateNotificationReceipt()`/`notification_receipts` 경로를 재사용하므로 사용자/회사/알림 id 단위 상태가 웹과 앱 사이에서 공유된다.
- 응답은 app contract용 `NotificationReceiptResult`로 감싸고, 웹 전용 `href`는 제거해 기존 app `NotificationFeedResult`와 같은 target 기반 탐색 모델을 유지한다.
- HTTP smoke는 app feed에서 받은 `application_reminder:*` 알림을 읽음 처리한 뒤 숨김 처리하고, 상태/timestamp와 `href` 비노출을 검증한다.

## 63차 구현 범위

### 고객지원 사용자 해결/재오픈

- `/api/web/support/tickets/[ticketId]` PATCH를 추가해 사용자가 접근 가능한 문의를 `resolved`로 표시하거나 `open`으로 다시 열 수 있게 한다.
- 새 테이블 없이 기존 `support_tickets.status`, `updatedAt`, `metadata.userStatusEvents`를 갱신해 사용자 주도의 처리 완료/재오픈 이력을 남긴다.
- `/account#account-support-tickets`에는 각 문의 row에 `해결됨 표시`와 `다시 열기` 버튼을 추가해 운영자 답변 이후 사용자가 지원 루프를 직접 닫을 수 있게 한다.
- 접근권한은 기존 답장/첨부와 같은 회사 id, 사용자 id, 세션 이메일 기준을 재사용한다.
- HTTP smoke는 잘못된 ticket id boundary를 항상 검증하고, 저장소가 연결된 환경에서는 resolve/reopen roundtrip을 확인한다.

## 64차 구현 범위

### Signed billing webhook 검증 강화

- signed billing webhook 정상 경로를 서버 함수 레벨 verifier로 추가해 `x-cunote-signature`와 Stripe 호환 `stripe-signature`를 모두 검증한다.
- webhook payload 정규화가 구독 상태, 플랜명, 좌석 한도, provider portal, invoice/payment method 신호를 안정적으로 읽는지 확인한다.
- 같은 provider/event id가 이미 저장되어 있으면 구독/청구/결제수단 projection upsert 전에 `duplicate: true`로 반환해 provider 재시도가 상태를 다시 흔들지 않게 한다.
- verifier는 DB env를 제거한 상태에서 실행해 개발/CI 환경의 실제 청구 테이블을 건드리지 않고 서명/정규화/오류 경계만 확인한다.
- `pnpm verify:billing-webhook`을 추가하고 통합 `pnpm test`에 포함했다.

## 65차 구현 범위

### SaaS MVP readiness snapshot

- `buildSaasReadiness()`를 추가해 완결형 SaaS 목표의 핵심 흐름을 공개 신뢰, 가입/온보딩, 핵심 사용 흐름, 워크스페이스 운영, 상업 운영, 운영 콘솔 섹션으로 나눠 점검한다.
- 각 항목은 현재 워크트리의 page/API route 파일 존재와 운영 법무 readiness를 증거로 삼아 `ready` 또는 `attention` 상태를 계산한다.
- `/api/admin/status`의 `runtime.saasReadiness`와 `surfaces`에 `saas_readiness`를 추가해 운영자가 배포 전 MVP 커버리지와 누락 key를 확인할 수 있게 한다.
- `/admin` 실행 구성 패널에 SaaS readiness 점수와 상위 누락 항목을 표시한다. 기존 Work zone 표면만 재사용하고 새 시각 토큰은 추가하지 않는다.
- `pnpm verify:saas-readiness`를 추가하고 통합 `pnpm test`에 포함해 route coverage와 법무 환경값 fallback/ready 경계를 검증한다.

## 66차 구현 범위

### SaaS MVP readiness 상세 운영 패널

- `/admin`에 `SaaS MVP readiness` 상세 패널을 추가해 65차 snapshot의 섹션/항목별 ready/attention 상태를 운영자가 직접 확인할 수 있게 한다.
- 각 항목은 핵심 page/API evidence 또는 missing key를 최대 3개까지 표시해 다음 구현/환경 설정 작업으로 바로 이어지게 한다.
- 별도 API나 저장소를 만들지 않고 `/api/admin/status`와 같은 `runtime.saasReadiness` 출처를 사용한다.
- HTTP smoke의 admin HTML 경계에 `SaaS MVP readiness`와 섹션명 렌더 검증을 추가했다.

## 67차 구현 범위

### SaaS MVP readiness Markdown export

- `GET /api/admin/status/saas-readiness`를 추가해 admin-only SaaS MVP readiness Markdown 리포트를 내려받을 수 있게 했다.
- 리포트에는 전체 점수, 완료 항목 수, 누락 요약, 섹션별 항목/evidence/missing 표, 다음 운영 액션을 포함한다.
- `/admin`의 `SaaS MVP readiness` 상세 패널에 Markdown 다운로드 액션을 추가해 배포 전 점검 회의나 운영 공유 자료로 바로 사용할 수 있게 했다.
- 새 저장소나 별도 배치를 만들지 않고 `buildSaasReadiness()`와 같은 runtime snapshot을 사용한다.
- `pnpm verify:saas-readiness`는 Markdown report 렌더를 검증하고, HTTP smoke는 report endpoint의 200/403 boundary와 admin HTML 다운로드 링크를 확인한다.

## 68차 구현 범위

### 운영 법무 readiness Markdown handoff

- `renderLegalReadinessMarkdown()`을 추가해 `buildLegalReadiness()` 결과를 운영자가 공유 가능한 Markdown 점검표로 변환한다.
- `GET /api/admin/status/legal-readiness`를 추가해 admin-only 운영 법무 readiness 리포트를 내려받을 수 있게 했다.
- 리포트에는 전체 상태, 점수, 누락 환경값, 항목별 상태/설명/환경값, 배포 전 확인 액션을 포함한다.
- `/admin` 실행 구성 패널에 `법무 Markdown` 다운로드 액션을 추가해 사업자 정보, 개인정보 문의처, 수탁사/국외이전 값 확정 작업으로 바로 이어지게 했다.
- 새 DB나 provider 없이 기존 `getLegalConfig()`/`buildLegalReadiness()` 출처를 재사용하므로 공개 약관, 개인정보 처리방침, 계정 export와 같은 설정 출처를 유지한다.
- `pnpm verify:legal-readiness`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 report endpoint의 200/403 boundary와 admin HTML 다운로드 링크를 확인한다.

## 69차 구현 범위

### 고객지원 운영 큐 Markdown export

- `renderAdminSupportTicketReport()`를 추가해 최근 고객지원 티켓을 SLA 초과/임박, 담당자 미지정, 상태/우선순위 요약, 최근 메시지/첨부, 운영 액션으로 정리한다.
- `GET /api/admin/flywheel/support-tickets/report`를 추가해 admin-only Markdown 리포트를 내려받을 수 있게 했다.
- 리포트는 새 DB나 이메일/Slack provider 없이 기존 `getAdminFlywheelSnapshot()`의 `recent.supportTickets` projection을 재사용하고, snapshot 조회 실패 시에도 빈 운영 큐 리포트를 반환한다.
- `/admin` 고객지원 패널에 `운영 큐` 다운로드 액션을 추가해 일일/주간 운영 공유 자료로 바로 사용할 수 있게 했다.
- 변경된 `DESIGN.md` 기준에 맞춰 새 색상/토큰을 만들지 않고 기존 shadcn button variant와 semantic CSS 변수만 사용했다.
- `pnpm verify:admin-support-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 report endpoint의 200/403 boundary와 admin HTML 다운로드 링크를 확인한다.

## 70차 구현 범위

### 구독 좌석 한도와 팀 초대 write guard 정합화

- 팀 화면과 워크스페이스 요약은 `billingSubscription.seatLimit`을 기준으로 좌석 사용량을 보여주지만, 서버의 초대/수락 write guard는 Early Access 고정 5석을 기준으로 판단하던 불일치를 수정했다.
- `createTeamInvitation()`, `resendTeamInvitation()`, `acceptTeamInvitation()`이 공유하는 `readTeamSeatUsage()`에서 `billing_subscriptions.seat_limit`을 읽어 현재 구독/수동 운영 상태의 좌석 한도를 적용한다.
- 구독 row가 없거나 잘못된 값이면 기존 Early Access 5석으로 안전하게 폴백하도록 `resolveTeamSeatLimit()`을 추가했다.
- `loadWorkspaceOverview()`의 팀 좌석 usage metric도 `seatUsage.seatLimit`을 limit으로 사용해 `/team`, `/billing` 명세, 초대 write guard가 같은 좌석 한도를 공유하게 했다.
- `pnpm verify:team-seat-limit`을 추가하고 통합 `pnpm test`에 포함해 resolver 경계와 subscription seat limit 연결을 검증한다.

## 71차 구현 범위

### 팀 운영 Markdown export

- `renderTeamOperationsReport()`와 `buildTeamOperationsReport()`를 추가해 현재 워크스페이스의 멤버, 좌석, 초대 이력, 권한 변경 이력, 운영 액션을 Markdown으로 내려받을 수 있게 했다.
- `GET /api/web/team/report`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 팀 운영 리포트를 받을 수 있게 했다.
- 리포트는 새 테이블을 만들지 않고 `/team` 화면과 같은 `loadWorkspaceOverview()` 출처를 사용하므로 구독 좌석 한도, 멤버 목록, 초대 상태, 권한 변경 감사 로그가 화면과 export에서 일치한다.
- `/team` hero에 `팀 리포트` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:team-operations-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/team` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 72차 구현 범위

### 알림센터 Markdown export

- `renderNotificationCenterReport()`와 `buildNotificationCenterReport()`를 추가해 현재 알림센터의 읽지 않음/숨김 수, 알림 설정, 우선순위 요약, 알림 상세, 운영 액션을 Markdown으로 내려받을 수 있게 했다.
- `GET /api/web/notification-feed/report`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 자신의 알림 리포트를 받을 수 있게 했다.
- 리포트는 새 테이블이나 외부 email/push provider 없이 기존 `loadNotificationCenter()` 출처를 사용하므로 웹/앱 알림 feed, receipt 상태, 신청 리마인더, 고객지원 입력 필요 알림과 같은 정렬/상태 규칙을 재사용한다.
- `NotificationFeedPanel`에 `리포트` 다운로드 액션을 추가해 `/dashboard`와 `/account` 알림센터에서 같은 산출물로 이동하게 했다.
- 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:notification-center-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/dashboard`/`/account` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 73차 구현 범위

### 계정 보안/법무 Markdown export

- `renderAccountSecurityReport()`와 `buildAccountSecurityReport()`를 추가해 현재 사용자의 로그인 방식, 비밀번호 설정 상태, 회사 접근권한, 약관/개인정보 동의 이력, 운영 법무 설정, 보안 제외 항목, 다음 액션을 Markdown으로 내려받을 수 있게 했다.
- `GET /api/web/account/security-report`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 계정 보안 리포트를 받을 수 있게 했다.
- 리포트는 새 테이블이나 auth provider 없이 기존 `loadAccountSecurityStatus()`와 `getLegalConfig()` 출처를 사용하므로 `/account` 화면, 계정 데이터 export, 공개 법무 문서의 버전/문의처와 같은 설정을 공유한다.
- `AccountSecurityStatusPanel`에 `보안 리포트` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:account-security-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/account` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 74차 구현 범위

### 회사 설정 Markdown export

- `renderSettingsReport()`와 `buildSettingsReport()`를 추가해 현재 회사의 설정 완료도, 회사 검증 상태, 온보딩 단계, 접근 가능한 회사 목록, 워크스페이스 사용량, 운영 액션을 Markdown으로 내려받을 수 있게 했다.
- `GET /api/web/settings/report`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 설정 리포트를 받을 수 있게 했다.
- 리포트는 새 테이블 없이 기존 `loadOnboardingProgress()`와 `loadWorkspaceOverview()` 출처를 조합하므로 `/settings`, `/onboarding`, `/team`, `/billing`에서 보는 회사/동의/알림/좌석/초안 사용량과 같은 기준을 공유한다.
- `/settings` hero에 `설정 리포트` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:settings-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/settings` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 75차 구현 범위

### 기회 맵 Markdown export

- `renderDashboardReport()`와 `buildDashboardReport()`를 추가해 현재 대시보드의 적격/확인 필요/부적격/마감 임박 수, 회사 기준, 상위 기회, 우선 액션, 다음 보강 질문, 운영 액션을 Markdown으로 내려받을 수 있게 했다.
- `GET /api/web/dashboard/report`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 기회 맵 리포트를 받을 수 있게 했다.
- 리포트는 새 저장소나 별도 provider 없이 `/dashboard` 화면과 같은 `loadServiceDashboard()` 출처를 사용하므로 매칭, 액션 큐, 다음 질문, 룰셋/스코어링 버전이 화면과 export에서 일치한다.
- `/dashboard` hero에 `대시보드 리포트` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:dashboard-report`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/dashboard` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 76차 구현 범위

### 신청 캘린더 구독 feed

- `buildApplicationCalendarSubscription()`과 signed token 검증을 추가해 현재 회사/사용자 범위의 읽기 전용 신청 캘린더 feed URL을 생성한다.
- `GET /api/web/applications/calendar-subscription`은 session-protected Markdown handoff로 Webcal/HTTPS 구독 URL, 만료일, 공유 주의사항을 내려준다.
- `GET /api/web/applications/calendar-feed/[token]`은 public calendar client용 endpoint이며 HMAC token을 검증한 뒤 기존 `buildApplicationBoardCalendar()`를 재사용해 `text/calendar` feed를 반환한다.
- `/applications` hero에 `구독 URL` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `CalendarClock` 아이콘만 사용했다.
- `pnpm verify:application-calendar-subscription`을 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/applications` 링크, Markdown subscription handoff, public feed의 `BEGIN:VCALENDAR` 응답을 확인한다.

## 77차 구현 범위

### 고객지원 이메일 handoff export

- `renderSupportTicketEmailHandoff()`와 `buildSupportTicketEmailHandoff()`를 추가해 고객지원 티켓의 최신 공개 admin 답변을 `.eml` 파일로 내려받을 수 있게 했다.
- `GET /api/admin/flywheel/support-tickets/[ticketId]/email-handoff`를 추가해 admin-only 경계에서 `message/rfc822` attachment를 생성한다. 이메일/Slack provider가 연결되기 전에도 운영자가 메일 클라이언트로 답변을 이어 보낼 수 있다.
- 최신 공개 답변이 없으면 접수 확인 기본 문안을 생성하고, 본문 하단에는 접수번호, 유형, 접수일, 원문 문의를 포함해 외부 발송 전 맥락을 잃지 않게 했다.
- `/admin` 고객지원 티켓 행에 `이메일` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Download` 아이콘만 사용했다.
- `pnpm verify:admin-support-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 admin 성공 경로의 `.eml` attachment와 비관리자 403 boundary를 확인한다.

## 78차 구현 범위

### 수동 결제 안내서 export

- `renderBillingPaymentInstructions()`와 `buildBillingPaymentInstructions()`를 추가해 provider 결제 연동 전에도 회사 내부 결재, 세금계산서 요청, 운영팀 상담에 쓸 수 있는 Markdown 안내서를 생성한다.
- `GET /api/web/billing/payment-instructions`를 추가하고 session-protected route policy에 등록해 현재 회사 접근권한이 있는 사용자만 수동 결제 안내서를 받을 수 있게 했다.
- 안내서에는 현재 계약 기준, 결제 처리 방식, 세금계산서 수신 정보, 최근 플랜 전환 요청, 내부 결재 체크리스트, 다음 액션을 포함한다. 실제 결제 문구는 선택 env `CUNOTE_BILLING_PAYMENT_INSTRUCTIONS`로 운영 환경에서 재정의할 수 있다.
- `/billing` hero에 `결제 안내` 다운로드 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `ReceiptText` 아이콘만 사용했다.
- `pnpm verify:billing-payment-instructions`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/billing` 링크와 report endpoint의 Markdown attachment를 확인한다.

## 79차 구현 범위

### 팀 초대 이메일 handoff export

- `renderTeamInvitationEmailHandoff()`와 `buildTeamInvitationEmailHandoff()`를 추가해 초대 token으로 pending 팀 초대를 확인하고 `.eml` 초대 메일 파일을 생성한다.
- `GET /api/web/team/invitations/handoff/[token]`을 public token route로 추가했다. 이메일 provider가 없어도 초대 링크를 가진 운영자가 메일 클라이언트에서 바로 보낼 수 있는 `message/rfc822` attachment를 받을 수 있다.
- `.eml`에는 초대받은 이메일, 회사명, 역할, 초대 링크, 만료일, 미요청 초대 안내를 포함한다. 토큰이 짧거나 만료/처리된 초대면 JSON error boundary로 응답한다.
- `/team` 초대 링크 생성/재발행 결과에 `메일 파일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 색상/CSS를 만들지 않고 기존 shadcn `buttonVariants`와 lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:team-invitation-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 invalid token boundary와, DB 저장 초대가 있는 경우 `.eml` attachment를 확인한다.

## 80차 구현 범위

### 청구서 이메일 handoff export

- `renderBillingInvoiceEmailHandoff()`와 `buildBillingInvoiceEmailHandoff()`를 추가해 저장된 청구 이력을 청구 담당자에게 전달 가능한 `.eml` 파일로 변환한다.
- `GET /api/web/billing/invoices/[invoiceId]/email-handoff`를 session-protected route로 추가했다. 결제 provider 포털이나 이메일 provider가 완전히 연결되기 전에도 회사 접근권한이 있는 사용자가 메일 클라이언트로 청구 안내를 전달할 수 있다.
- 수신자는 세금계산서 이메일, 청구 담당자 이메일, 현재 세션 이메일 순서로 결정하고, 본문에는 청구번호, 상태, 금액, 세금/부가세, 서비스 기간, provider 원본/영수증 URL을 포함한다.
- `/billing` 청구 이력 row에 `메일 파일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `buttonVariants`와 lucide `Mail` 아이콘만 사용했다.
- `CUNOTE_BILLING_EMAIL` 선택 환경값을 추가해 청구 handoff 발신 주소를 운영 환경에서 분리할 수 있게 했다.
- `pnpm verify:billing-invoice-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 invalid invoice id boundary를 확인한다.

## 81차 구현 범위

### 신청 리마인더 이메일 handoff export

- `renderApplicationReminderEmailHandoff()`와 `buildApplicationReminderEmailHandoff()`를 추가해 신청 파이프라인의 특정 공고 상태를 `.eml` 파일로 내려받을 수 있게 했다.
- `GET /api/web/applications/[grantId]/reminder-email`을 session-protected route로 추가했다. 이메일 provider나 외부 push provider 없이도 현재 신청 단계, 다음 액션, 담당자, 리마인더, 마감일, 상세 링크를 메일 클라이언트로 전달할 수 있다.
- 수신자는 현재 세션 이메일을 사용하고, 발신 표시는 `CUNOTE_APPLICATIONS_EMAIL` 또는 지원 이메일로 폴백한다.
- `/applications` 공고 카드에 `리마인더 메일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `buttonVariants`와 lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:application-reminder-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 샘플 공고의 `.eml` attachment 성공 경로를 확인한다.

## 82차 구현 범위

### 계정 삭제 요청 이메일 handoff export

- `buildAccountDeletionEmailHandoff()`와 `accountDeletionEmailHandoffDownloadResponse()`를 추가해 개인정보 권리 행사/계정 삭제 요청을 운영 개인정보 담당자에게 전달 가능한 `.eml` 파일로 내려받을 수 있게 했다.
- `GET /api/web/account/deletion-request/handoff`를 session-protected route로 추가했다. 고객지원 티켓 저장소나 이메일 provider가 아직 완전 자동 발송을 담당하지 않아도 사용자가 메일 클라이언트에서 개인정보 요청을 이어 보낼 수 있다.
- 수신자는 `CUNOTE_PRIVACY_EMAIL` 또는 지원 이메일로 폴백하고, 본문에는 요청자, 회신 이메일, 회사 ID, 사용자 ID, 현재 권한, 삭제/처리 정지 요청 범위와 확인 요청 항목을 포함한다.
- `/account` 계정 데이터 삭제 요청 panel에 `메일 파일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `buttonVariants`와 lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:account-deletion-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 `/account` 링크와 `.eml` attachment 성공 경로를 확인한다.

## 83차 구현 범위

### 플랜 전환 요청 이메일 handoff export

- `loadBillingPlanRequestForCompany()`를 추가해 `support_tickets.metadata.kind = billing_plan_request`로 저장된 플랜 전환 요청을 회사 범위에서 단건 조회할 수 있게 했다.
- `renderBillingPlanRequestEmailHandoff()`와 `buildBillingPlanRequestEmailHandoff()`를 추가해 저장된 전환 요청을 청구/영업 담당자에게 전달 가능한 `.eml` 파일로 내려받을 수 있게 했다.
- `GET /api/web/billing/plan-requests/[requestId]/email-handoff`를 session-protected route로 추가했다. 결제 provider나 CRM/email provider가 완전히 연결되기 전에도 사용자가 플랜 상담 요청을 외부 메일 클라이언트로 이어 보낼 수 있다.
- 수신자는 `CUNOTE_BILLING_EMAIL` 또는 지원 이메일로 폴백하고, 본문에는 요청 번호, 요청자, 회신 이메일, 현재 플랜/좌석, 희망 플랜/좌석/청구 주기, 요청 내용, 운영 확인 항목을 포함한다.
- `/billing` 최근 상담 요청 row에 `메일 파일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `buttonVariants`와 lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:billing-plan-request-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 invalid request id boundary와, DB에 전환 요청이 저장된 경우 `.eml` attachment 성공 경로를 확인한다.

## 84차 구현 범위

### 고객지원 접수 이메일 handoff export

- `renderSupportTicketIntakeEmailHandoff()`와 `buildSupportTicketIntakeEmailHandoff()`를 추가해 `/support`에서 작성한 문의 내용을 지원팀에 전달 가능한 `.eml` 파일로 내려받을 수 있게 했다.
- `POST /api/web/support/tickets/handoff`를 public route로 추가했다. DB 저장소나 이메일 provider가 연결되지 않아 문의가 `queued`로 끝나는 환경에서도 사용자가 같은 내용을 메일 클라이언트로 지원팀에 전달할 수 있다.
- `.eml`에는 접수번호, 문의 유형, 요청자, 회신 이메일, 제목, 본문, 첨부 파일 존재 여부와 운영 확인 항목을 포함한다. 첨부 원본은 `.eml`에 포함하지 않고, 메일 발송 시 별도 첨부해야 함을 본문에 명시한다.
- `/support` 접수 성공 feedback에 `메일 파일` 액션을 추가했다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `Button`과 lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:support-ticket-intake-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 validation boundary와 `.eml` attachment 성공 경로를 확인한다.

## 85차 구현 범위

### 비밀번호 재설정 이메일 handoff export

- `renderPasswordResetEmailHandoff()`와 `buildPasswordResetEmailHandoff()`를 추가해 비밀번호 재설정 링크를 이메일 provider 문안과 같은 `.eml` 파일로 내려받을 수 있게 했다.
- `POST /api/web/auth/password-reset/handoff`를 public route로 추가하되, 기존 `CUNOTE_PASSWORD_RESET_DEBUG_LINK` 또는 non-production 조건에서만 동작하게 했다. production에서는 재설정 URL을 공개 응답이나 handoff로 노출하지 않는 보안 경계를 유지한다.
- `.eml`에는 요청 이메일, 재설정 링크, 만료 시간, 1회성/만료 보안 안내, 지원 문의처를 포함한다. 전달 링크는 현재 origin의 `/reset-password?token=...`만 허용해 외부 URL을 메일 파일로 포장하지 못하게 했다.
- `/forgot-password` 화면은 debug reset URL이 반환된 경우에만 `메일 파일` 액션을 보여준다. 변경된 `DESIGN.md` 기준에 맞춰 새 CSS나 임의 색상 없이 기존 shadcn `Button`, `buttonVariants`, lucide `Mail` 아이콘만 사용했다.
- `pnpm verify:password-reset-email-handoff`를 추가하고 통합 `pnpm test`에 포함했다. HTTP smoke는 non-production handoff `.eml` attachment 성공 경로를 확인한다.

## 86차 구현 범위

### 고객지원 문의 기록 export 검증 강화

- `renderSupportTicketTranscript()`를 순수 renderer로 공개해 DB/R2가 없어도 고객지원 문의 기록 Markdown 산출물을 검증할 수 있게 했다.
- 문의 기록에는 공개 thread, 공개 첨부 파일 URL, 접수 상태, 우선순위, 예상 응답 기준일을 포함하고 내부 운영 메모와 담당자 정보는 제외한다는 정책을 verifier로 고정했다.
- `pnpm verify:support-ticket-transcript`를 추가하고 통합 `pnpm test`에 포함했다. 이 검증은 Markdown 표 escape, 공개 대화 라벨, 첨부 archive URL, UTF-8 attachment 헤더를 확인한다.
- 화면/UI는 기존 `/account#account-support-tickets`의 `대화 내려받기` 액션과 `/api/web/support/tickets/[ticketId]/transcript` route를 그대로 사용하므로 변경된 `DESIGN.md` 기준의 Work zone 표면을 건드리지 않는다.

## 87차 구현 범위

### SaaS readiness 증거 강화

- `buildSaasReadiness()`가 page/API route 존재뿐 아니라 각 MVP 흐름을 검증하는 `pnpm verify:*` script 존재까지 evidence로 계산하게 했다.
- 공개 신뢰, 가입/온보딩, 핵심 신청 흐름, 팀/계정, 청구, 고객지원, 운영 콘솔 항목마다 관련 verifier script를 연결해 readiness 100%가 단순 파일 존재만 뜻하지 않게 했다.
- SaaS readiness Markdown report의 `Evidence / Missing` 열에는 `script:verify:*` 항목이 함께 표시되므로 운영자가 배포 전 어떤 검증 경로가 준비되어 있는지 확인할 수 있다.
- `pnpm verify:saas-readiness`는 `script:verify:support-ticket-transcript`, `script:verify:billing-webhook` 같은 핵심 script evidence가 실제 리포트에 포함되는지 검증한다.

## 88차 구현 범위

### SaaS readiness test chain 증거 강화

- `buildSaasReadiness()`가 각 MVP 흐름의 verifier script 존재뿐 아니라 통합 `pnpm test` 체인 포함 여부도 `test:verify:*` evidence로 계산하게 했다.
- 공개 랜딩 검증인 `verify:landing-grants`를 통합 test chain에 포함해 readiness에 연결된 verifier가 기본 검증 명령에서 누락되지 않게 했다.
- SaaS readiness Markdown report에는 `script:verify:*`와 `test:verify:*`가 함께 표시되어 운영자가 “검증 파일이 있다”와 “기본 검증 체인에서 실행된다”를 구분해 확인할 수 있다.
- `pnpm verify:saas-readiness`는 `test:verify:support-ticket-transcript`, `test:verify:billing-webhook` evidence가 실제 리포트에 포함되는지 검증한다.

## 89차 구현 범위

### Admin readiness 증거 요약

- `/admin`의 `SaaS MVP readiness` 상세 패널에서 각 항목의 evidence를 `페이지`, `API`, `검증 스크립트`, `검증 체인`, `환경값` 개수로 요약해 보여주게 했다.
- readiness Markdown에는 전체 evidence를 유지하고, admin 화면은 Work zone 밀도를 유지하기 위해 요약 + 앞부분 evidence/missing만 보여준다.
- 새 색상이나 CSS 토큰을 추가하지 않고 기존 `admin-readiness-section small` 표면을 재사용했다.
- HTTP smoke는 admin HTML에 `검증 체인` 요약이 렌더되는지 확인한다.

## 90차 구현 범위

### SaaS release checklist export

- 운영자가 배포 직전 같은 검증 순서와 readiness 상태를 공유할 수 있도록 admin-only `/api/admin/status/release-checklist` Markdown export를 추가했다.
- 체크리스트에는 SaaS/legal readiness 요약, release gate, 필수 명령(`typecheck`, route policy, OpenAPI, legal/SaaS readiness, outbound email, HTTP smoke, build, diff check), 누락 항목, 운영 메모를 포함한다.
- `/api/admin/status` surface와 admin route verifier에 `saas_release_checklist`를 추가해 새 admin route가 보호되고 운영 콘솔에서 발견 가능하도록 했다.
- `/admin`은 변경된 디자인 시스템의 기존 Work zone 패턴을 유지하기 위해 새 CSS/토큰 없이 `admin-readiness-actions`와 `buttonVariants`만 재사용해 checklist 다운로드 링크를 제공한다.
- `pnpm verify:saas-release-checklist`를 추가하고 통합 `pnpm test` 체인 및 SaaS readiness evidence에 포함했다. HTTP smoke는 endpoint의 200/403 boundary와 admin HTML 링크를 확인한다.

## 91차 구현 범위

### SaaS release 실행 증적 runbook

- `/api/admin/status/release-checklist` Markdown을 단순 명령 목록에서 실행 증적을 채울 수 있는 release runbook으로 확장했다.
- 체크리스트에는 각 required command의 `Result`, `Started At`, `Finished At`, `Notes`를 남기는 `Execution Evidence` 표를 포함한다.
- admin runtime snapshot(repository adapter, data source, auth mode/provider, database configured)을 같은 export에 넣어 운영자가 배포 시점의 실행 구성을 함께 보관할 수 있게 했다.
- 배포 담당자/검토자/배포 창/승인 여부를 적는 sign-off 섹션과 인증, 회사 접근권한, 결제/고객지원/문서 다운로드 실패 시 rollback 검토 기준을 추가했다.
- 새 UI 스타일이나 provider 없이 기존 admin-only export surface와 `pnpm verify:saas-release-checklist`, HTTP smoke boundary를 확장해 검증한다.

## 92차 구현 범위

### 비밀번호 재설정 outbound email adapter

- `CUNOTE_EMAIL_WEBHOOK_URL`이 설정된 환경에서는 비밀번호 재설정 토큰 생성 직후 outbound email webhook으로 재설정 안내 메일을 자동 발송한다.
- 운영 환경에서는 기존처럼 재설정 URL을 공개 응답에 노출하지 않고, provider 미설정 환경에서는 기존 debug/handoff 흐름을 유지한다.
- 수동 `.eml` handoff와 자동 발송이 같은 제목/본문을 사용하도록 비밀번호 재설정 메일 본문 renderer를 공유했다.
- `CUNOTE_EMAIL_WEBHOOK_SECRET`, `CUNOTE_EMAIL_FROM`, `CUNOTE_EMAIL_REPLY_TO` 환경값을 추가해 운영 relay, Resend/SES bridge, Make/Zapier endpoint 등에 연결할 수 있게 했다.
- `pnpm verify:outbound-email`을 추가하고 통합 `pnpm test` 및 SaaS readiness evidence에 포함했다. HTTP smoke는 provider 미설정 환경의 password reset delivery skip 상태를 확인한다.

## 93차 구현 범위

### 팀 초대 outbound email delivery

- `CUNOTE_EMAIL_WEBHOOK_URL`이 설정된 환경에서는 팀 초대 생성/재발행 시 초대 링크를 outbound email webhook으로 자동 발송한다.
- provider 미설정, demo, DB 미연결 환경에서는 기존 링크 복사와 `.eml` handoff 흐름을 유지하고 `emailDelivery.status = skipped`로 응답한다.
- 팀 초대 `.eml` handoff와 자동 발송이 같은 제목/본문 renderer를 공유하도록 분리했다.
- `/team` 초대 패널은 새 디자인 표면 없이 기존 notice 영역에서 이메일 발송 성공/실패/미설정 상태에 맞는 안내를 보여준다.
- HTTP smoke는 provider 미설정 환경의 팀 초대 delivery skip 상태를 확인하고, `verify:team-invitation-email-handoff`는 자동 발송과 handoff가 공유하는 subject/text/tag를 검증한다.

## 94차 구현 범위

### 고객지원 접수 outbound email delivery

- `CUNOTE_EMAIL_WEBHOOK_URL`이 설정된 환경에서는 `/support` 문의 접수 직후 운영 지원 주소로 고객지원 문의 메일을 자동 전달한다.
- provider 미설정, DB 미연결, demo 환경에서는 기존 `.eml` handoff 흐름을 유지하고 `emailDelivery.status = skipped`로 응답한다.
- 고객지원 접수 `.eml` handoff와 자동 발송이 같은 제목/본문/tag renderer를 공유하도록 분리했다.
- `/support` 접수 완료 feedback은 변경된 디자인 시스템에 맞춰 새 토큰이나 새 카드 표면을 만들지 않고, 기존 attachment feedback 영역에서 이메일 전달 성공/실패/미설정 상태를 안내한다.
- HTTP smoke는 provider 미설정 환경의 고객지원 문의 delivery skip 상태를 확인하고, `verify:support-ticket-intake-email-handoff`는 자동 발송과 handoff가 공유하는 subject/text/tag를 검증한다.

## 후속 구현 범위

- 결제/플랜 고도화: provider별 상세 매핑, 카드 등록 UI, 전자세금계산서 자동 발행/원본, 좌석 과금
- 팀 관리 고도화: 좌석 과금과 결제 provider 연동, 이메일 provider 직접 발송
- 문서 내보내기 고도화: 원문 양식 기반 DOCX/PDF 고도화와 provider별 파일 변환 품질 관리
- 신청 파이프라인 고도화: Google/Microsoft 캘린더 API 양방향 동기화, 이메일 리마인더, 팀 담당자 push/email 알림, 결과 일정 자동 알림
- 고객지원 백오피스 고도화: 이메일/Slack 직접 전송 provider 연동, 고급 SLA escalation
- 운영 법무: 실제 사업자 정보, 개인정보보호책임자, 수탁사/국외이전 값을 배포 환경변수로 확정

## 검증

- `pnpm typecheck`
- `pnpm verify:route-policy`
- `pnpm verify:openapi`
- `pnpm verify:saas-release-checklist`
- `pnpm verify:outbound-email`
- `pnpm verify:grant-document-draft-persistence`
- `pnpm verify:service-usecases`
- `pnpm verify:web-http`
- `pnpm build:web`
- `git diff --check`
