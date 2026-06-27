# 지원사업 아카이브/인사이트 구현 계획

작성일: 2026-06-27

## 목표

현재 우리가 커버하는 지원사업 풀을 표준화된 `grant_raw -> grants -> grant_criteria` 계약으로 DB에 축적하고, 같은 데이터에서 주기적으로 운영 인사이트를 뽑아 매칭 정확도와 수집 효율을 개선한다.

## 구현 범위

1. K-Startup 아카이브 배치
   - `source=sample|live`를 지원한다.
   - 기본은 dry-run이고, `--write`일 때만 DB에 쓴다.
   - `source_cursor`와 기존 `grant_raw.raw_hash`를 읽어 신규/변경/동일 공고를 구분한다.
   - 동일 공고는 publish 대상에서 제외해 DB write와 후속 재추출 비용을 줄인다.
   - live 모드는 page/perPage/pages/all/maxPages 옵션으로 점진 실행할 수 있게 한다.

2. 기업마당 지원사업 아카이브 배치
   - `source=sample|live`를 지원한다.
   - live 모드는 `BIZINFO_SERVICE_KEY`로 현재 기업마당 지원사업 목록을 가져온다.
   - 기존 `grant_raw.raw_hash`를 먼저 비교해 변경분만 추출 대상으로 보낸다.
   - `ANTHROPIC_API_KEY`가 있으면 기존 tool-use 추출기로 `grant_criteria`를 만든다.
   - API 키가 없을 때는 `--allow-text-only-fallback`을 명시한 경우에만 `text_only + needs_review` 기준으로 발행한다.
   - write+live 모드에서는 공고 첨부를 R2에 업로드하고 `grant_raw.attachments`와 `grant_attachment_archives`에 보관 URL을 남긴다.
   - `.hwp` 첨부는 `hwp5html`/`pyhwp` 경로로 Markdown 변환을 시도하고, 변환 Markdown도 R2에 업로드해 추출 입력과 아카이브 메타에 연결한다.
   - raw hash가 동일해도 기존 첨부에 R2 보관본이 없으면 attachment refresh 대상으로 다시 발행한다.
   - write 모드에서는 `extraction_log`를 남겨 이후 골든셋/eval 루프와 연결한다.

3. 인사이트 스냅샷
   - 현재 DB의 공고, criteria, cursor, 피드백/골든셋/eval 카운트를 집계한다.
   - 커버리지, text_only/needs_review 비율, dedup 상태, 품질 루프 공백, cursor 신선도를 규칙 기반 signal로 만든다.
   - 결과를 `grant_insight_snapshots`에 저장한다.
   - 기본은 dry-run이고, `--write`일 때만 snapshot을 남긴다.

4. 운영 연결
   - package script로 `archive:kstartup`, `archive:bizinfo`, `archive:cycle`, `insights:grants`를 제공한다.
   - dry-run verifier를 추가해 DB 없이도 핵심 계획 로직을 검증한다.
   - admin flywheel 표면에 `grant_insight_snapshots`, `grant_attachment_archives` 카운트와 최근 항목을 노출한다.

## 비범위

- Cloud Scheduler/Vercel Cron 배포 설정은 추가하지 않는다. 먼저 CLI와 DB 계약을 고정한 뒤 배포 환경의 실행 주기와 secret 경계를 붙인다.
- 새로운 LLM 추출 품질 개선은 하지 않는다. 이번 작업은 아카이빙/분석 기반을 만든다.

## 실행 예시

```bash
pnpm archive:kstartup -- --source=sample
pnpm archive:kstartup -- --source=live --pages=3 --compare-db
pnpm archive:kstartup -- --source=live --all --maxPages=500 --write
pnpm archive:bizinfo -- --source=sample
pnpm archive:bizinfo -- --source=live --limit=20 --compare-db
pnpm archive:bizinfo -- --source=live --limit=100 --archive-attachments --write
pnpm archive:bizinfo -- --source=live --limit=100 --allow-text-only-fallback --write
pnpm archive:bizinfo -- --source=live --limit=100 --write --skip-attachment-conversion
pnpm archive:cycle -- --source=live --write --with-db-steps
pnpm insights:grants
pnpm insights:grants -- --write
```

## 검증 게이트

```bash
pnpm verify:kstartup-archive
pnpm verify:bizinfo-archive
pnpm verify:grant-attachment-archive
pnpm verify:grant-insights
pnpm verify:db-migrations
pnpm typecheck
```

## 후속 단계

1. `grant_insight_snapshots`를 기반으로 weekly report 또는 admin chart를 만든다.
2. 스케줄러는 개발 DB에서 `archive:kstartup -> archive:bizinfo -> publish:dedup -> match:states:refresh -> insights:grants` 순서로 검증한 뒤 운영에 연결한다.
3. HWP 외 PDF/DOCX 본문 변환기를 붙이면 첨부 기반 추출 커버리지를 더 높일 수 있다.
