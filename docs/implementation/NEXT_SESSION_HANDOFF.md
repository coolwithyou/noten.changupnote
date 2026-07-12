# 다음 세션 핸드오프 — 인증·배포

작성: 2026-06-27 · 직전 작업: DB 이전 → Vercel 배포 → 도메인 연결 → 인증(이메일/패스워드+OAuth) 구현

새 세션에서 이 파일을 먼저 읽고 이어서 진행한다.

---

## 🔴 가장 먼저 (prod가 1커밋 뒤처져 있음)

랜딩 헤더 로그인 연결 커밋(`0cfaaaf`)이 **아직 배포되지 않았다**(재배포 취소됨). prod는 직전 인증 배포 상태.

```bash
# 둘 중 하나로 라이브 반영
vercel deploy --prod --yes --token "$VERCEL_CLI_TOKEN_FULL"   # .env.vercel.local에서 로드
# 또는 git push (GitHub coolwithyou/noten.changupnote → Vercel noten 자동배포)
```
반영 후 검증: `https://changupnote.com/` 헤더에 `로그인` CTA 노출 + `/login` 폼 동작.

---

## ✅ 완료·검증된 것

- **DB 이전**: 구 us-east-1 → 신 **changupnote**(Supabase ap-northeast-2, **noten 계정**). 27테이블 139행 일치 검증. 구 DB 앱 스키마 드롭. 백업: `backups/cunote_full_20260627_142340.sql`(gitignore).
- **Vercel**: noten 팀 `changupnote` 프로젝트(`.vercel/project.json`), GitHub 연결. Root Directory=`apps/web`, buildCommand=`pnpm --filter @cunote/contracts build && pnpm --filter @cunote/core build && next build`.
- **도메인**: `changupnote.com`+`www` → Vercel, TLS 발급(Cloudflare DNS-only). NEXTAUTH_URL=`https://changupnote.com`.
- **env(prod/preview/dev)**: DATABASE_URL·SUPABASE_DB_URL(changupnote 6543), CUNOTE_REPOSITORY_ADAPTER=drizzle, CUNOTE_AUTH_DB_ADAPTER=drizzle, NEXTAUTH_SECRET, GOOGLE/KAKAO 키, R2/POPBILL/KSTARTUP/ANTHROPIC 등.
- **인증 구현(라이브 검증 완료)**: 이메일/패스워드(가입 201·로그인 세션·오답 차단) + Google·Kakao provider 활성. 마이그레이션 `0005`(users.password_hash) changupnote 적용. bcrypt rounds 12.
- **커밋**: `0cfaaaf` 랜딩 연결+설계문서 / `940f664` 인증 구현 / `0bae2cc` docs 허브 / `6c65552` 디자인 시스템. working tree clean.

---

## ▶ 다음 작업 후보

1. **랜딩 연결 배포**(위 🔴) → 라이브 확인.
2. **OAuth 브라우저 1회 테스트** — Google/Kakao 버튼 실제 동의 플로우(리다이렉트 URI/동의 화면 검증). 헤드리스로는 provider 활성까지만 확인됨.
3. **로그인 상태 헤더** — 세션 시 `로그인` CTA를 `대시보드`/계정 메뉴로 전환(랜딩이 세션 인지하도록).
4. 비밀번호 재설정·이메일 인증·PASS 본인인증·레이트리밋·account linking. (상세: `창업노트_로그인화면_설계.md` §7)

---

## ⚠️ 환경·함정 메모

- **Vercel 토큰**(`.env.vercel.local`의 `VERCEL_CLI_TOKEN_FULL`)은 CLI가 출력에 echo해 **로그 노출 이력 있음**. Vercel 작업은 **REST API(Authorization 헤더)** 사용 권장. 노출 의심 시 재발급.
- **DB 접속**: 마이그레이션/psql은 **세션 풀러 포트 5432**(`drizzle-kit migrate`는 6543 트랜잭션 풀러에서 advisory lock 이슈). 런타임은 6543. 직결 호스트 `db.<ref>.supabase.co`는 IPv6 전용으로 로컬 도달 불가.
- **로컬 셸 zsh**: unquoted 변수 단어분할 안 됨 → 플래그는 리터럴로(`$VAR`에 여러 옵션 담지 말 것). curl 로컬 apex DNS 네거티브 캐시 시 `--resolve changupnote.com:443:216.198.79.1`.
- **빌드**: 워크스페이스 패키지(`@cunote/core`/`contracts`) `exports`가 `dist/`(gitignore) → next build 전 패키지 선빌드 필수. 로컬은 `pnpm build:web`.
- **배포 방식**: `vercel deploy`(CLI)는 **로컬 워킹트리** 업로드, `git push`는 **커밋본** 자동배포 → 두 경로 결과가 다를 수 있음.
- `.env`의 `# NEW Database` 블록 POSTGRES_*/SUPABASE_* 은 앱 미사용(코드는 DATABASE_URL/SUPABASE_DB_URL만 읽음).
