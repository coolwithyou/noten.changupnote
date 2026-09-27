# 아스카웍스 현행 미검수 공고 분석·가상 답변 실험

## 목표

2026-09-27 현재 `open + visible + 신청기간 내`인 미검수 공고의 정확한 ID와 원문 상태를 고정한다. 현재 회사의 확인된 사실을 보존하고, 미확인 답변은 별도 비영속 시나리오에서만 가정하여 재매칭한다. 분석·검수 결과와 서비스 공급 결과를 분리한다.

## 완료 조건과 검증

- [x] 현행 모집단의 고유 ID·source revision·원문/첨부 준비도·역사 실행 재사용·보류 사유를 모델 무호출로 분류한다. `pnpm lab:matching-campaign -- --prepare --as-of=<ISO> --allowed-stage=prepare --child-size=25`; classification 합계와 원본 snapshot 수를 대조한다.
- [x] 회사 사실과 가상 답변 가정을 분리해 현재 매칭과 미확인 기업규모 한 축의 가상 매칭 변화를 오프라인으로 비교한다. DB 회사 답변은 수정하지 않는다.
- [x] 실제 모델 호출 대상·모델·전송·동시성·호출 상한·child 수·재사용 수를 정확한 manifest SHA로 확인한다. 예전 502건 계획의 수량을 오늘 507건 실행 권한으로 사용하지 않는다.
- [ ] 507건 중 모델 직행 불가 444건의 원문 복구·현행 조건 검수·품질 보류를 대상별로 해소한다. 현 단계의 분류는 원문 조건 검수 완료로 세지 않는다.
- [ ] 승인된 exact 범위의 matching-only 분석을 실행하는 경우 receipt·독립 검수·HOLD를 대상별 결산한다. 서비스 DB 승격은 별도 권한으로 남긴다.

## 결정·경계

- 사용자 목표는 현재 507건의 원문 조건 검수 후 아스카웍스 가상 답변으로 추천 가능성을 시험하는 것이다. 숫자 507은 2026-09-27 18:26 KST 조회값으로, 실행 전에 변동을 재측정한다.
- `discovery`는 미검수 공급 상태이며 507번 신규 모델 호출을 의미하지 않는다. 현행 material과 과거 receipt를 대조해 재사용·검수만·신규·원문 변경·HOLD로 나눈다.
- 로컬 구독 분석은 `matching_only`만 고려한다. 확인되지 않은 기업규모·매출·인원·인증·수혜 이력은 실제 사실로 저장하거나 제공하지 않는다.
- live 모델 실행은 exact manifest 범위의 사용자 승인과 analysis launch grant가 있어야 한다. 분석 완료도 서비스 쓰기 승인이 아니다.

## 현황

- 2026-09-27 18:26 KST 읽기 전용 기준: serving 후보 1,509건, 상태 `open` 및 신청기간 내 536건, 그중 discovery 507건·verified 29건. verified 29건의 실제 회사 매칭은 eligible 0, conditional 19, ineligible 10. 상태 `unknown` 954건은 오늘 지원 가능 모집단으로 단정하지 않는다.
- 2026-09-27 20:36~20:43 KST 읽기 전용 campaign 준비: snapshot 536 = discovery 507 + verified 29, ID 누락 0. discovery 출처는 BizInfo 292·K-Startup 215. discovery 중 당일 마감 7건은 원문 복구 4·현행 조건 검수 3으로 분류됐다.
- discovery 507건의 정확한 후속 작업: 준비된 matching-only 실행 63, 현행 조건 검수 150, 원문 변경 검수 38, 기존 분석 검수 22, 원문 커버리지 검수 6, 원문 복구 202, 품질 보류 해소 26. 합계 507. **507건 원문 조건 검수는 아직 끝나지 않았다.** 63건 실행만으로 507건을 결산할 수 없다.
- 원문 복구 209건(discovery 202·verified 7)의 readiness를 같은 as-of에 재조회한 결과 209/209 `attachments_missing`이다(조회 누락 0·후속 작업 불일치 0). 선언된 첨부의 원본 바이트가 archive에 모두 결속되지 않아 검수·분석으로 넘길 수 없는 상태다. 추가 blocker는 analysis_missing 115, criteria_review_incomplete 94 등이며 서로 중복된다. 첨부 메타데이터만으로 원본 조건을 추정하거나 빈 manifest로 대체하지 않는다.
- launch 범위 campaign `679c5876952b9116d7d67511af96634c1a018dd76ba7bbc29371f9f39ca7bab6`, classification `3efe044d33a1c2ea6e9a18919dec7d5ca64a5432c8012e6c929d71bf383765f7`. 두 파일의 bytes SHA가 이름과 일치한다. child manifest 25/25/13건의 SHA는 각각 `e7ab04625ec63ab95035ecd32327cec7493225abc134eb368ac72e2bf80b67fd`, `f3d0680e2d3f77e555b354199cdbb72c09fe0eeaa28c4fab39a7811f384831ca`, `0b78a2ace462635e20a27b382948d10683d614707f17a2bd6c017105f3e2eb88`; 세 파일의 bytes SHA도 일치한다. `matching_only`·`claude-cli`·`claude-opus-5`·동시성 2·child 순차 실행·최대 63 target. 서비스 신청서 분석은 포함하지 않는다.
- 2026-09-27 20:43 KST `lab:matching-campaign --status`는 첫 child `not_started`, existing grant 0을 반환했다. campaign의 `liveExecutionAuthorized=false`; 사용자 exact 범위 승인과 child별 grant 전까지 모델 실행 0건이다. 감시 인계의 세 번째 13건 manifest도 동일한 미실행 child이며 exact19 집계와 분리한다.
- 아스카웍스 실제 저장 답변에서 검수된 29건은 eligible 0·conditional 19·ineligible 10. **미확인** `size=중소기업`만 self-declared confidence 0.6으로 메모리에서 가정하면 eligible/recommendable 1건(인도 BTS 전시회), conditional 18·ineligible 10으로 변한다. 이는 지원 자격 증명이나 저장된 사용자 답변이 아니다. 미검수 507건의 매칭 결과도 아니다.
- 위 20:43 KST 준비 시점에는 모델 호출·가상 답변 저장·서비스 DB 쓰기·승격이 모두 0건이었다.

## 2026-09-27 23:06 KST 첨부 원본 복구 실측

- 초기 209건의 선언 첨부는 총 615개였고 archive 행 492개 중 142개가 storageKey/SHA 결속 불완전이었다. 선언 첨부 기준 원본 미확보는 266개(archive 행 없음 126, 행은 있으나 결속 불완전 140)였다. 중복된 불완전 행에 의한 허위 HOLD는 0건이었다.
- 기존 백필 dry-run은 이미지 제외 시 138/209건·171개 첨부만 선택했다. macOS Vision OCR를 K-Startup 백필 CLI에 연결하고, exact 복구에서 현재 detail의 선언 첨부를 복원했다. 이후 같은 209건 dry-run은 209/209건·268개 첨부를 선택했다.
- K-Startup `178981`의 같은 파일명·다른 원본 URL에서 repository hydration이 옛 archive identity를 현재 첨부에 붙이는 오류를 재현했다. URL exact 결속으로 수정했고 회귀 검증을 추가했다. 원본 URL이 다른 경우는 새 material로 다룬다.
- 오늘 마감 4건(BizInfo 1, K-Startup 3)을 exact ID로 R2 archive 및 DB publisher에 반영했다. 4/4 원본 보관 성공, 모델 호출 0. 포스터 JPG는 macOS Vision OCR confidence 약 0.796으로 변환 성공, HWP 신청서 1개는 원본 보관은 성공했으나 `hwp5html` 부재로 변환 실패했다. PDF 2개는 원본 보관 성공·이 경로에서는 변환 생략이다.
- 같은 209개 ID를 재조회하면 `attachments_missing`은 209→205, 다음 작업 불일치 0→4다. 이 4건도 분석·추천 준비 완료는 아니다. 2건에는 `attachment_manifest_missing`, 1건에는 `analysis_missing`, 2건에는 기존 source revision/검수 blocker가 남는다(중복 가능). 현재 백필 dry-run은 잔여 205/205건·264개 첨부를 선택한다.
- 위 4건의 archive/publisher 변경 이후 20:43 KST campaign은 역사 snapshot이다. 신규 live 모델 실행 전에는 모집단·material·manifest를 다시 준비해 exact 결속과 권한을 재판정한다.
- 관련 `verify:kstartup-archive`, `verify:extraction-manifest-hydration`, 웹 typecheck는 수정 SHA에서 PASS. 서비스 DB 변경은 위 exact 4건의 원문 archive/publisher만이며 분석 승격·회사 답변 저장은 0건이다.

## 2026-09-27 23:20 KST 확대 배치와 변환 보정

- 마감 가까운 K-Startup 25건·37개 첨부와 BizInfo 25건·26개 첨부를 별도 dry-run 후 순차 archive/publisher 처리했다. K-Startup 25/25 target·37/37 원본 보관, BizInfo 25/25 target·25/26 원본 보관. BizInfo 1개 다운로드는 빈 파일이어서 원본 결속 없이 실패로 남겼다.
- HWP/HWPX 변환 실패 14개 중 1개는 실제 HWPX였는데 HWPv5용 `hwp5html` 가용성 검사가 네이티브 unzip 변환까지 차단한 결함이었다. 매직 바이트로 HWPX를 확인한 뒤 pyhwp 없이 변환하도록 수정하고, 해당 exact 원본을 재처리해 `hwpx-xml-unzip-v1` 변환·동일 SHA 결속을 확인했다. 나머지 HWPv5 변환 실패 13개는 `hwp5html` 부재로 남는다.
- 최초 209건 readiness를 다시 조회하면 `attachments_missing` 156건, 다음 작업 불일치 53건이다. 이 53건은 원본 첨부 누락만 해소된 것으로, `attachment_manifest_missing` 46건·기존 분석/검수 blocker가 남아 있어 매칭 공급 완료로 세지 않는다. 모델 호출·분석 승격·회사 답변 저장은 0건이다.
- 수정 범위의 `verify:grant-attachment-archive`(25 assertions), `verify:kstartup-archive`, `verify:bizinfo-archive`, `verify:extraction-manifest-hydration`, `verify:ingestion-publish`, `verify:runtime-repositories`, 웹 typecheck, package runtime freshness를 확인했다.

## 현재 실행 경계

- prepared campaign의 exact 범위(위 SHA, 세 child, 최대 63건, matching-only, receipt 종결)를 사용자에게 제시하고 승인받는다. 승인 전 `lab:launch:grant`, `lab:launch`, 서비스 승격을 실행하지 않는다.
- 444건은 이번 campaign의 launch admission에서 제외됐다. 특히 원문 복구 202건은 선언 첨부의 원본 archive 결속부터 확보해야 하며, 현행 조건 검수 150건은 기존 분석 또는 원문 결속 판단이 필요하다. 원문 검수 결과 없이 추천 가능 0건을 시장의 실제 부재로 해석하지 않는다.
