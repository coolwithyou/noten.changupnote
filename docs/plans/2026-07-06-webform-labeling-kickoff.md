# 웹폼 샘플 5건 라벨 — 착수 문서 (Gate 1 마지막 배치)

작성일: 2026-07-06 (세션 7 이후 핸드오프 정리)
상위 근거: 마스터 §17 샘플("웹폼 링크 5개 — 값 준비 가이드 검증용") · §9.7 웹폼 가이드 · `docs/gate1-field-map-labeling-guide.md` "웹폼 5개의 라벨" 절
작업 방식: 메인 세션이 오케스트레이션·검수·커밋, 캡처·사전 라벨은 위임 가능 (단 브라우저 캡처는 메인 세션 도구(agent-browser/Claude in Chrome)가 필요할 수 있음 — 착수 시 판단)

---

## 현재 좌표

- Gate 1 사전 라벨 45/45 문서 완료(HWP 30 + PDF 10 + DOCX 4 + 배치 간 중복 1), 정본은 DB(`field_map_review_docs`), `spike-labels/`는 임포트 소스. **웹폼 5건이 샘플 구성의 마지막 배치(배치 5).**
- 목적이 다름에 주의: 파일 양식은 Gate 2 layout 측정의 분모지만, **웹폼은 "값 준비 가이드"(§9.7) 검증용** — layout 엔진 측정 대상이 아니다 (eval 러너는 페이지 이미지 없는 문서를 스킵하므로 측정 인프라에 무해).

## 제약 (마스터 §9.7 — 위반 금지)

- **로그인 후에만 접근 가능한 폼은 캡처 대상에서 제외** (많은 포털이 해당할 것 — 대상 선정이 첫 관문)
- 캡처만 한다: 자동 제출·버튼 클릭 진행 금지, CAPTCHA 우회 금지, 계정/인증정보 저장 금지
- 폼에 실데이터 입력 금지 (빈 폼 상태로 캡처. 단계 이동에 더미 입력이 필수인 폼은 그 단계에서 중단하고 접근 가능한 범위만 라벨)

## 절차

1. **대상 선정** — grants DB(bizinfo/kstartup)의 공고에서 온라인 신청 링크를 수집 → 브라우저로 로그인 없이 폼이 보이는지 확인 → 5개 확보. 로그인 게이트로 5개를 못 채우면 채운 만큼 진행하고 미달 사유를 이 문서에 기록(§9.7의 "상위 포털 한정" 원칙과 일치 — 무리해서 채우지 않는다).
2. **캡처** — 폼 단계(step)별 스크린샷(풀페이지 권장) → `spike-labels/pages/docNN-PP.png` (PP = 캡처 순번 = stepIndex와 일치시킴).
3. **사전 라벨** — `spike-labels/docNN.json`, 기존 스키마 그대로(`docRef/labeledBy/labeledAt/pageCount/fields[]`, field는 `key/label/section/type/required/applicantFills/manual/page/bbox/notes`):
   - 기준서 "웹폼 5개의 라벨" 규정: **bbox 대신 stepIndex·fieldLabel** → 구현 관례: `page`=stepIndex, `bbox`=null, `label`=화면 표시 라벨 그대로, notes에 selector 힌트(선택).
   - `labeledBy: "opus-prelabel"` — AI 사전 라벨은 검수 없이 golden 승격 금지(순환성 가드).
   - key는 표준 key 사전(기준서 §"표준 key 사전") 우선, 애매 케이스는 기준서 판정 사례집에 추가.
   - `docRef` 형식: 파일 양식은 `source:sourceId:filename`이었음 — 웹폼은 `source:sourceId:web:<URL>` 형태를 제안하되, **`import-review-docs.ts`의 `deriveSourceFilename(docRef)` 호환을 먼저 확인**하고 필요 시 스크립트를 웹폼 docRef에 관대하게 소폭 보강(기존 45건 동작 무변경 조건).
4. **문서 번호** — doc55~59 제안. doc32~40 결번은 재사용 금지(기존 결번 관례 유지). 확정 전 `spike-labels/REVIEW-QUEUE.md` 관례 확인.
5. **임포트** — `import-review-docs`(dry-run 기본 → `--write`: DB upsert + R2 `label-review/pages/` 업로드, 멱등) → 신규 문서 검수 질문 생성(`pnpm generate:review-questions` — 신규 문서만 대상이 되는지 옵션 확인) → `REVIEW-QUEUE.md`에 배치 5 등재.
6. **검증 후 완료 선언** — 임포트 후 `/internal/review`에서 신규 문서가 스크린샷과 함께 렌더되는지 실확인(mock 인증 로컬 가능), typecheck(스크립트 수정 시).

## 작업 규칙 (요약 — 상세는 `docs/plans/2026-07-06-knowledge-loop-next-session.md` "작업 규칙" 절과 동일)

- 병렬 세션: 시작 시 `git status --porcelain`, M/?? 파일 수정 금지, 커밋은 경로 명시 스테이징(한 Bash 호출로 add+commit)
- env 정본 `.env.local`→`.env`, 시크릿 값 출력 금지
- 검수 확정 전 golden 승격 금지

## 트리거 문장 (제안)

> 웹폼 샘플 5건 라벨을 진행해줘. `docs/plans/2026-07-06-webform-labeling-kickoff.md` 읽고 절차대로 — 대상 선정(로그인 없는 폼만)부터. 캡처는 브라우저 도구로 직접 하고, 사전 라벨 초안은 Opus에 위임해도 좋다.

## 진행 로그

- 2026-07-06: 착수 문서 작성. 미착수.
