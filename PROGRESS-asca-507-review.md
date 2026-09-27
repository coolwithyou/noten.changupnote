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

## 2026-09-27 23:36 KST 원문 복구 후속 계측

- K-Startup 2차 25건·36개, 3차 25건·35개 원본을 순차 보관했다. 2차 HWP 변환 실패 2건과 이전 배치 HWP 실패는 격리된 pyhwp `hwp5html`로 재처리해 원본 SHA를 유지하며 변환했다. 3차 이미지 3개는 OCR 텍스트 없음/신뢰도 부족으로 원본만 보관했다.
- BizInfo 2차 25건에서 원본 25/26개, 3차 24건에서 25/25개를 보관했다. `PBLN_000000000126284`의 HWP 다운로드가 두 번 모두 0바이트여서 원본 미확보로 남았다. `PBLN_000000000121107`의 대형 포스터는 원본은 보관했으나 20 MiB OCR 상한으로 변환 실패했다. BizInfo HWP 변환 실패 6개는 pyhwp로 재처리했다.
- K-Startup 2차 처리와 `179249` HWP 재처리를 잠시 겹쳐 실행했을 때 후자가 source cursor DB 쓰기에 실패했다. 2차 완료 후 동일 원본 SHA로 순차 재시도해 성공했다. 이후 서비스 쓰기 배치는 겹치지 않게 실행한다.
- 원래 209건의 readiness 재조회에서 `attachments_missing`이 58건으로 감소했다. 다음 작업 분류 불일치는 151건으로, 원본 선행 조건 일부 해소를 뜻할 뿐 원문 조건 검수 완료나 추천 준비 완료가 아니다. `attachment_manifest_missing` 125건, `analysis_missing` 115건 등은 중복 blocker다.
- K-Startup 마지막 대상 `177944`는 원본 이미지 2/2 보관과 publisher 결속을 마쳤다. 이미지가 공간 사진이라 OCR은 텍스트 없음으로 실패했다. 조건을 추정하거나 텍스트가 확보됐다고 표시하지 않는다.
- 감시 사건 `fe3bb11f…`는 13건 matching_only 준비 manifest `0b78a2ac…`의 SHA 확인·exact19 ID 교집합 0·grant/receipt/status null이라는 인계다. 이 사건은 launch 승인이 아니다. exact19 19 terminal(18 publishable/1 held)은 별도 종결 상태로 유지한다.
- BizInfo 후속 4차 24건·26개 첨부는 24/24 target·26/26 원본 보관, 5차 32건·52개 첨부는 32/32 target 처리·51개 원본 보관이었다. 5차의 `PBLN_000000000124661`은 공고문과 서식 2개가 모두 0바이트를 반환했다.
- 빈 파일 원인을 공식 기업마당 상세 페이지와 대조했다. API snapshot의 `printFlpthNm`은 `atchFileId=FILE_000000000772558&fileSn=1`인데, 2026-09-27 현재 상세 페이지의 본문출력파일 다운로드는 같은 `atchFileId`의 `fileSn=2`다. 후자를 GET하면 HWPv5 87,040바이트·SHA256 `a3ad7572e2acdf27e490fd22cbbfe59d7a685947f2817727eae8dafde69ba393`이지만 전자는 0바이트다. 주요 공고문이므로 신청서 파일만으로 원문 충족 판정을 내릴 수 없다. API URL에 다른 파일 바이트를 붙여 저장하지 않고, 공식 페이지의 URL 변경을 source revision과 결속하는 수집 경로를 설계·검증해야 한다.
- 첫 209건의 최종 재계측은 `attachments_missing` 2건, 즉 207건의 원본 보관 선행 조건만 해소됐다. 2건은 위 `PBLN_000000000126284`, `PBLN_000000000124661`이다. 후자는 공식 페이지의 공고문 파일명도 API snapshot의 `수정.hwp`에서 `변경.hwp`로 달라졌고, 공식 다운로드의 `fileSn`은 공고문 1·서식 2/3인 반면 API snapshot은 0·0/1이다. 이 두 건은 단순 다운로드 재시도 대상이 아니라 공식 상세와 API의 source revision 불일치로 보류한다. 나머지 207건에는 `attachment_manifest_missing` 171건, `analysis_missing` 115건 등의 후속 작업이 남는다(중복 집계).
- 23:43:38 KST 고정 모집단 536건을 모델 무호출로 재분류했다. 동일 ID 536건이며, 원래 `recover_source` 209건은 새 공고 matching-only 준비 5·원문 변경 재분석 준비 87·현행 조건 검수 56·원문 변경 검수 32·품질 보류 23·원문 커버리지 검수 4·원문 복구 유지 2건으로 이동했다. 즉 207건의 원본 보관 완료가 207건의 즉시 매칭 가능을 뜻하지 않는다.
- 새 campaign `c550e17a20b2ed226074b329bbef66467c9e2accf8e91722f33f24ec084913d1`, classification `026b9f5f69699a2ec4cc867c44988fc3ba7a3ee48561d5c5055849f1e76d0ea7`. 이전 준비물 63건(25/25/13)은 같은 child SHA로 유지되고, 새 준비물 92건(25/25/25/17)이 추가됐다. 전체 155건은 승인된 live 실행이 아니라 `allowedStage=prepare`, `liveExecutionAuthorized=false` 상태다. 536건 중 review/hold/release 등은 모델 실행 대상에 합산하지 않는다.
- 새 campaign의 `--status`는 첫 child `not_started`, completedGrantIds 0, existing grant SHA 0, `liveExecutionAuthorized=false`를 반환했다. 감시자가 인계한 13건은 이 campaign에서도 정확히 세 번째 기존 child로 유지되고, exact19와 섞이지 않는다.
- 감시 추가 사건 `91fa00bd…`의 17건 `matching_only` manifest `5e8c9323…`는 새 campaign 마지막 child와 동일하다. 인계 내용의 bytes SHA PASS·exact19 교집합 0·grant/receipt 0을 별도 사건으로 기록하며 launch 또는 품질 승인이 아니다.
- 23:50 KST 기업마당 official detail 페이지의 `atchFileId:fileSn`과 저장된 API snapshot을 현재 모집단 BizInfo 310/310건에서 읽기 전용 대조했다(페이지 오류 0). 일치 306건, 불일치 4건: `126284`, `124661`, `126496`, `126545`. 앞의 둘은 원본 누락 HOLD, 뒤의 둘은 기존 보관본과 공식 최신 원본의 SHA/크기가 모두 다르다. 뒤의 둘은 현재 `source_review`/`review_current_conditions`로 campaign 미포함이며, 원문 최신화 검수 전 매칭 준비로 간주하지 않는다. 이 대조는 파일 링크에 한정하며 본문 의미나 모든 출처의 완전성을 증명하지 않는다.
- 동일 대조를 `pnpm audit:bizinfo-official-links -- --classification=<SHA JSON>` 읽기 전용 명령으로 고정했다. 분류 파일 bytes SHA를 검증하고, 공식 도메인의 다운로드 ID·순번만 비교하며 페이지를 읽을 수 없으면 오류로 분리한다. 새 명령의 전체 실측은 310/310 조회·306 일치·4 불일치·오류 0으로 일회성 조사와 동일했다. parser 회귀 테스트와 웹 typecheck PASS.
- 새 campaign의 `review_current_conditions` 224건을 현재 readiness로 재조회했다(224/224). 200건은 `analysis_source_binding_missing + attachment_manifest_missing + criteria_review_incomplete + criteria_structure_incomplete`, 6건은 같은 조건에서 첨부 manifest만 있음, 14건은 질문 누락/낡은 질문과 기준 검수 미완성, 4건은 기준 검수만 미완성이다. 이 200건은 155건 launch의 자동 후속 대상이 아니므로 기존 자산을 exact 검증하거나 별도 원문 조건 검수 경로가 필요하다.
- 200건의 기존 history는 `legacy_material` 92, 무이력 57, terminal 23, primary 23, legacy 5다. 따라서 200건 전체를 기존 분석 결과의 단순 발행 대기로 취급할 수 없고, 반대로 전부 신규 모델 호출 대상으로 단정할 수도 없다.
- 단일 검수 예시 `PBLN_000000000116832`의 원본 HWP 변환문을 읽었다. 고용보험 피보험자 10인 기준과 일부 10인 미만 예외, 기업탐방형에 한정된 20명 교육장 조건이 명시된다. 저장 criterion에는 `insured_workforce` 예외 text_only, 기업탐방형 시설 조건 needsReview, `size=중소기업`이 있다. size 문구는 첨부에는 없지만 API `trgetNm=중소기업`에 있고, 현행 코드·정책은 이를 공식 신청대상 근거로 취급한다. 단지 첨부에 없다는 이유로 size criterion을 오류라고 단정하거나 삭제하지 않는다. 트랙별 조건은 전체 신청기업의 자동 탈락 조건으로 확대하지 않고 exact 검수 대상으로 남긴다.
- 2026-09-28 00:00 KST 이후 9월 27일 `current-matching-campaign`은 역사 as-of다. 위 `c550…` 승인 요청에 대한 응답이 와도 그 SHA를 바로 실행하지 않고, 현재 신청기간·material을 다시 준비해 exact 실행 범위를 새로 판정한다.

## 2026-09-28 00:00:31 KST 현재 모집단 재준비

- 현재 신청기간 기준 고유 target은 536→529로 7건 감소했다. 모델 무호출 campaign `c053563e7560f631dcb9c67e498a878d1a73d2d6651fc238706503652204920a`, classification `608d1a2f2ca9ea7703497c22adfc6811eaf95c96c245a34c141576692b94a725`로 새로 봉인했다. 준비 child는 25/25/25/25/13/17/24건의 총 154건이다. 9월 27일 `c550…` 155건 범위는 더 이상 현재 실행 범위가 아니다.
- 전일 536건과 현재 529건의 grantId 집합을 대조하면 빠진 7건은 모두 전일 `closesToday=true`였고 신규 대체 grantId는 0건이다. 빠진 7건 중 모델 준비 대상은 1건, 현행 조건 검수 4건, 원문 변경 검수 2건이었다.
- 현재 529건 분류는 reusable 4, primary review 220, prepared not started 154, source changed review 78, quality held 73이다. `--status`는 첫 child `not_started`, 완료 0, 기존 grant 0, live authorization false를 반환했다. 13건 `0b78…`·17건 `5e8c…` child SHA는 유지됐지만 순서와 전체 campaign 결속이 바뀌었다. exact19와 합산하지 않는다.
- 새 exact campaign에 대한 승인 없이는 grant/launch를 실행하지 않는다. 독립적으로 가능한 원문 링크 감사, 조건 검수·기존 분석 자산 감사와 아스카웍스 비영속 시나리오 검증을 계속한다.

## 2026-09-28 00:14 KST 현행 조건 검수·검색 필드 오류 축소

- 감시 사건 `a2c0acb4…`의 24건 `matching_only` manifest `5460aa508dd9f488968a10d8137c63e1f05050b7e03931aba70b6c03e3a91fa3`는 위 `c053…` campaign의 마지막 child다. 이번 세션에서 파일 bytes SHA도 확인했다. 감시 인계상 exact19 grantId 교집합 0, 결속 grant/receipt 0, snapshot status null이다. 준비 변경이며 실행·품질·서비스 쓰기 승인이 아니다.
- `c053…` classification bytes SHA를 검증한 뒤 `review_current_conditions` 220/220건의 저장 criterion 1,348개를 읽기 전용 집계했다. K-Startup 74건에 포털 검색 필드 `biz_enyy` 74개·`supt_regin` 26개·`biz_trgt_age` 22개, 합계 122개가 criterion으로 저장돼 있다. 이것은 원문 자격과 충돌할 **위험 집합**이지 74건 모두 오류 확정이나 추천 가능 집계가 아니다.
- K-Startup `179038`은 위험의 원문 확인 사례다. 보관된 HWPX 변환문 SHA `4c1fbc1b5a0ba1504f2560d5323d0a1cd867c0b75622127515e4c3433da5d7c4`와 현재 API 신청대상 상세가 AX의 Vertical AI Agent를 산업군 무관 모집 분야로, 법인 3년 미만 등을 *우대조건*으로 명시하며 우대조건 미충족자도 지원 가능하다고 말한다. 저장된 `biz_enyy` 검색 범주 유래 `biz_age <= 120개월` 필수 criterion은 그 원문 자격 근거가 아니다. 저장 `industry`/`size`/`other` text_only도 AX·LX 트랙과 우대/선별 조건을 전역 필수조건으로 섞어 needsReview다. 실제 아스카웍스 제품이 Vertical AI Agent인지 확인되지 않았으므로 이 공고의 지원 가능 판정·추천으로 승격하지 않는다.
- 재발 방지를 위해 K-Startup 기본 정규화에서 세 포털 검색 필드로부터 직접 자격 criterion을 만들지 않도록 했다. 명시적 신청대상·제외 문장의 파서는 유지한다. parser version은 v4로 올렸고, 검색 필드 회귀 테스트·LLM 병합 테스트·core/web typecheck·ingestion publish 검증·service usecases가 PASS했다. 기존 DB의 74건은 자동 수정되지 않았고, 원문별 검수 없이 일괄 삭제·승격하지 않는다.
- 이 코드 변경은 package runtime 계약을 바꾸므로 앞서 요청한 `c053…` live 승인에 대한 응답이 나중에 오더라도 그 준비물을 즉시 실행하지 않는다. 새 코드 빌드·고정 후 현재 source/input/period로 campaign을 재준비하고 exact 결속을 다시 확인한다.

## 2026-09-28 00:18 KST v4 코드 기준 재준비

- commit `70f0185`에서 K-Startup 검색 필드 자격 오인 방지와 검수 기록을 별도 작업 브랜치에 고정·push했다. `pnpm build:packages`와 runtime freshness 확인 후 모델 무호출로 현재 campaign `523e7ca28649bc084d26c5b9f1626ac0b676cd9136473fbcf8f851a334609b57`, classification `1da3591fab48640e3a0655068df96005030a90f4c4ecff29fcab34485c857fe1`을 봉인했다. 두 파일 bytes SHA는 파일명과 일치한다.
- 현재 529건의 ID·분류 행동은 직전 `c053…`와 동일하며 증감·변경 0건이다. 분류는 reusable 4, primary review 220, prepared 154, source changed 78, quality held 73. 7개 child는 동일 SHA 집합이나 순서만 바뀌어 24건 `5460…`이 첫 child가 됐다. 이번 `--status`는 그 child `not_started`, 완료 0, 기존 grant 0, live authorization false를 확인했다. 감시 사건의 24건은 여전히 모델 미실행 준비물이다.
- 이전 `c053…` 승인 질문은 현재 `523e…` exact campaign 질문으로 대체했다. 명시적 응답 전에는 grant/launch를 실행하지 않으며, 승인 응답이 오면 실행 직전 현재 기간·material·lease와 이 campaign의 결속을 다시 확인한다. 분석 결과 서비스 승격은 별도 권한이다.
- `179038`을 아스카웍스 현재 저장 프로필로 비영속 재평가했다. 저장 criterion 4개일 때와 검색 필드 유래 `biz_enyy` 1개만 메모리에서 제거했을 때 모두 `conditional / needs_core_review`다. 실제 회사 업력은 알려져 기존의 잘못된 10년 상한에도 pass였고, 나머지 AX·LX 혼입 `size`/`industry`/`other` 세 criterion은 모두 unknown·미검수 상태다. 따라서 검색 필드 오류를 제거하는 것만으로 이번 사례의 서비스 추천을 만들었다고 주장하지 않는다. 원문 트랙·우대·모집분야의 의미 결속 검수가 다음 차단점이다.

## 2026-09-28 과거 검색 필드 criterion의 판정 차단

- 앞서 식별한 122개 검색 필드 criterion의 parser version은 전부 `kstartup-field-parser-v3`였다. 현재 정규화 v4의 재발 방지와 별도로, matcher에서 v1~v3 검색 필드 `biz_enyy`·`biz_trgt_age`·`supt_regin`을 판정 근거에서 제외하고 해당 공고를 원문 검수 필요 상태로 유지한다. 명시적 신청대상 문장에 근거한 다른 criterion의 확정 탈락은 그대로 보존한다. ruleset은 v17로 올려 기존 저장 match_state를 현행 판정으로 오인하지 않게 했다.
- 새 ruleset을 적용한 읽기 전용 아스카웍스 74건 재평가: 과거 판정 재현 `ineligible / needs_core_review` 15건은 `conditional / needs_core_review`로 바뀌고 나머지 59건은 양쪽 모두 `conditional / needs_core_review`다. 이 15건은 실제 지원 자격 확정 사례가 아니라 *검색 필드만으로 내린 탈락을 취소한 사례*다. 서비스 DB·사용자 답변·매칭 상태 쓰기는 0건이다.
- 새 legacy 필터 회귀 테스트는 필터만 남은 공고의 보류, 원문 기반 조건 통과와 함께 있을 때의 보류, 원문 기반 확정 탈락의 보존을 확인했다. core `match.test` 55건, 결격 매칭 51건, premises 및 질문 노출 회귀, `pnpm test:matching-unit`, `pnpm verify:match-state-refresh`, core/web typecheck PASS. 배포 전 서비스 화면 검증이 필요하다.
- ruleset v17의 *역사적 대량 refresh 계획기*를 읽기 전용으로 실행했더니 active grant 1,502건·회사 146곳의 직교 조합 219,292건을 계획했다. 그중 실제 저장 상태 619건은 버전만 교체하면 되지만 신규 빈 조합 218,673건까지 채우는 과범위다. 현재 대량 write CLI는 코드에서 fail-closed하므로 이 계획을 운영 쓰기로 실행하지 않는다. 제품의 소유 회사 매칭은 요청 시 현재 ruleset으로 계산하고, 저장 cache는 version/revision/topology 불일치 시 사용하지 않는 경로를 확인했다. 전체 조합 생성은 이번 오류 보정의 필요 조건이 아니다.
- commit `e041beb`을 별도 작업 브랜치에 push했다. 현재 matching-only campaign을 다시 읽기 전용으로 준비한 결과 `d672b1597a07dabf454b1d8ace46726416e19ca41666fcfd2c8abb540c96cac4`, classification `a70a5166ba7a17d08423d41792ca30b4c61e7ccb908552891fe6f906a41da256`이다. 이전 `523e…` 대비 529개 ID·분류 행동·7개 child manifest SHA 집합과 순서가 같고 원문/material 차이 0건이다. 두 새 파일 bytes SHA PASS, 첫 24건 child `not_started`, 완료 0·grant 0·live authorization false다. 앞선 승인 질문에 아직 응답이 없으며 `c053…`·`523e…` SHA 자체를 실행 권한으로 삼지 않는다.

## 현재 실행 경계

- 20:43 KST campaign의 세 child SHA는 역사 준비물이다. 원문 archive/publisher 변경 후 current material을 다시 분류·prepare하고 새 exact 범위와 권한을 판정한다. 준비물을 근거로 `lab:launch:grant`, `lab:launch`, 서비스 승격을 실행하지 않는다.
- 444건은 이번 campaign의 launch admission에서 제외됐다. 특히 원문 복구 202건은 선언 첨부의 원본 archive 결속부터 확보해야 하며, 현행 조건 검수 150건은 기존 분석 또는 원문 결속 판단이 필요하다. 원문 검수 결과 없이 추천 가능 0건을 시장의 실제 부재로 해석하지 않는다.

## 2026-09-28 00:54 KST 기업마당 공식 상세 원문 복구와 재준비

- 최신 공식 상세 첨부 링크가 API snapshot과 다른 BizInfo 4건(`PBLN_000000000124661`, `126284`, `126496`, `126545`)을 exact 대상으로 했다. 공식 상세 조회와 기존 API 첨부 필드 해시를 결속한 dry-run 4건·9개 첨부 계획 SHA `75ba02641cc058534a4d8ed02902a8cb1dcfb685a4bb31116bb11e59c0933dab`을 확인하고, 이 계획과 동일한 현재 공식 상세 첨부만 R2 archive/DB publisher에 반영했다. 최초 실행은 4/4 target·9/9 원본 보관 성공, HWPX 2개 변환 성공, PDF 2개 정책상 생략, HWPv5 5개는 변환 도구 경로 부재로 실패했다. 원본 다운로드 실패는 0개다.
- 기존 격리 pyhwp 환경을 지정한 재처리 dry-run은 `124661` 3개·`126284` 2개의 HWP만 선택했다. 후속 exact 재처리에서 5/5 변환 성공·실패 0개다. 현재 DB 원문에는 네 공고 각각 공식 상세 snapshot과 현재 첨부 3/2/2/2개가 결속됐고, R2에서 원본 9개와 HWP/HWPX 변환문 7개를 다시 읽어 DB SHA와 대조한 결과 모두 PASS다. 이전 API URL을 현재 첨부로 재사용하지 않았다. 보관 archive 역사 행은 삭제하지 않았다.
- 현행 모델 무호출 campaign은 `42e37618f7deac8dcdab31b2b1c17964e46e2d1dcc571d2e0aec4e9d6470c814`, classification `916d49a05e2f8fa4d3e18fcb09418508e7c3450b722709d5b0ac626956d7fcc8`로 재준비했다. 두 파일 bytes SHA PASS. 529건 분류는 reusable 4·primary review 221·prepared 154·source changed 79·quality held 71이다. 직전 대비 `124661`은 `recover_source/quality_held`→`review_source_coverage/source_changed`, `126284`는 `recover_source/quality_held`→`review_current_conditions/primary_review_required`로 이동했다. 다른 두 건은 `review_current_conditions`를 유지한다. 154건의 7개 child manifest SHA는 변하지 않았고 첫 24건 `5460aa…`는 status `not_started`, completed 0·grant 0·live authorization false다.
- 본 복구는 원문 첨부 결속이다. 네 공고의 의미상 신청 자격 검수·아스카웍스 추천 판정과 전체 507건의 원문 조건 검수는 별도로 남는다. `d672…` campaign은 source revision 변경 전 snapshot이므로 실행 범위로 쓰지 않는다. 새 준비물도 grant/launch 승인이 아니며 exact19의 19 terminal(18 publishable/1 held)과 분리한다.

## 2026-09-28 01:07 KST 공식 링크 감사의 현재 원문 분리와 추가 복구

- 기존 공식 링크 감사 v1은 API↔공식 상세만 비교해, 공식 상세 원문으로 이미 복구한 4건도 계속 동일한 누락처럼 표시했다. 감사 v2는 API 링크와 저장된 현재 첨부 링크를 별도 대조한다. 공식 상세 다운로드의 `atchFileId:fileSn`만 비교하며 불명확한 페이지는 오류로 분리한다.
- 복구 직후 309건 재감사에서 API 불일치 4건은 현재 원문 링크가 모두 공식 상세와 일치했고, 반대로 API가 일치한 `PBLN_000000000126443`의 저장 현재 원문에는 공고문 PDF 1개가 누락돼 있음을 새로 발견했다. exact dry-run은 PDF 1개만 선택했고, 원본 R2 archive/DB publisher 처리 1/1 성공·실패 0이다. 현재 3개 첨부를 R2에서 다시 읽어 각 DB SHA와 대조해 PASS했다. PDF의 텍스트 변환은 이 경로에서 생략되며 자격 조건 검수 완료로 세지 않는다.
- 최신 전체 감사 v2는 현재 529건 classification의 BizInfo 309건을 조회해 `currentMatched=309`, `currentMismatched=0`, `currentMissing=0`, `errors=0`이다. API는 `apiMatched=305`, `apiMismatched=4`로 상위 공급 차이를 보존한다. 링크 ID 일치는 원본 바이트의 최신성이나 원문 의미의 완전성 증거가 아니다.
- 위 DB 보관 후 모델 무호출 campaign `312f13dfe8618ecd016f8fe3fb61e039842997c1bbc74a1f883df6b56ce0360a`, classification `4f705435f97e40f43c14ca06147e825f840c4f6e09509846e6d927fc3c4726a6`을 재봉인했다. 두 파일 bytes SHA PASS. 529건 분류 수량과 154건의 child 7개 SHA는 직전과 동일하며, 변화한 classification 항목은 한 건의 공급 evidence SHA뿐이다. 첫 24건 child `not_started`, 완료 0·grant 0·live authorization false다. 종전 `42e…` 전체 campaign은 이전 snapshot이다.
- v2 링크 판정 회귀 테스트, 웹 typecheck, `git diff --check` PASS. 실제 신청 자격·아스카웍스 추천 품질 인수는 미완료다.

## 2026-09-28 01:37 KST 현행 PDF 입력 실측과 부분 OCR 복구

- `312f…` 시점의 154개 matching-only 준비 target을 실제 `prepareLabAnalysis` 경로로 재조립했다. 총 선언 첨부 428개 중 입력 누락 79개·영향 target 62개였고, PDF 62개가 정확한 R2 원본 SHA를 가진 복구 후보였다. macOS Vision을 이용한 로컬 PDF 텍스트/OCR 복구 62개에서 52개 성공·10개 보류했다. 성공분의 R2 markdown SHA readback 및 DB document artifact upsert를 확인했다. 이후 재조립에서 누락은 27개·영향 target 17개로 감소했다. 실패는 20쪽 OCR 상한 7개와 최소 confidence 0.6 미달 3개다. 이 작업은 LLM/model 호출과 서비스 DB 매칭 승격을 하지 않았다.
- 모델 무호출 재준비 결과 campaign `e6c35d51b0bd2efc6ca75794a019fc39e369acc2eccf831ace03b1f7ec664a0a`, classification `f0c204ac94e1c3c7445993f4be02fbe4c8a268d821a4f9d224f3ea8a4a9947b2`이다. 현행 529건 분류는 reusable 4·primary review 221·prepared 105·source changed 128·quality held 71이며 7개 matching-only child는 13/25/25/25/25/25/16건, 합계 154건이다. status는 첫 13건 `not_started`, 기존 grant 0, live execution unauthorized를 반환했다. 52개 입력 SHA 변경으로 prepared→source_changed 49건이 이동했으며 새 승인으로 해석하지 않는다.
- 감시 사건 fingerprint `40c9a123…`는 이 `e6…` campaign의 마지막 16건 child `2aa1b23d435ef6ebdd201db3b613a99e80b6681a2d5afadb833876382c427bd5`에 대한 준비 변경 인계다. 전달된 bytes SHA PASS·exact19 교집합 0·grant/receipt 0·snapshot status null과 구분해, 이번 세션에서 campaign 첫 child status `not_started`를 확인했다. 직전 24건 `5460aa…` 준비물과 별개이며, 감시 세션의 `input_accepted`는 후속 완료나 실행 승인이 아니다. exact19 19 terminal(18 publishable/1 held)과 합산하지 않는다.
- 추가 물리 입력 감사 CLI `lab:matching-campaign:input-audit`는 child target 결속과 현재 input/attachment SHA를 비교한다. `e6…` 154건 감사에서 material drift 0, 입력 누락 27개·영향 target 17개, 공고문 누락 6개·영향 target 4개를 확인했다. `--require-announcement-coverage`는 공고문 누락에 exit 2로 차단했다.
- 보류 공고문 PDF 3개를 SHA 결속 원본으로 내려받아 `pdfinfo`/`pdftotext`/`pdfimages`로 대조했다. PDF 전체 21/23/23쪽에 비해 이미지 쪽은 7/10/4쪽이었다. OCR 상한을 문서 전체 쪽수가 아니라 실제 OCR 대상 쪽수 20쪽으로 적용하고, 필요한 쪽만 로컬 렌더링하도록 수정했다. OCR confidence 0.6, 원본 SHA, 업로드 SHA readback은 유지한다. exact 3개를 다시 복구한 결과 3/3 성공·실패 0, OCR 평균 confidence 0.734/0.751/0.648이다. 29쪽 전체 이미지 매뉴얼 등 나머지 20쪽 초과 문서는 계속 보류한다. 관련 회귀 테스트와 웹 typecheck PASS.
- 위 3개 document artifact 변경 뒤에는 `e6…` manifest도 이전 입력 snapshot이다. 현재 기간·material 재준비 및 입력 감사 후 최신 결과를 추가 기록한다.

## 2026-09-28 01:42 KST 최신 입력 재봉인·감사

- 변경 코드 `17efea6`을 작업 브랜치에 커밋·push한 뒤 formal prepare를 재실행했다. 현재 campaign `545636b811729a8af1f6238235d73452ead45d65e13a3ba5ec68e109a5380503`, classification `fa13b7bece7f583dfb2d7ca04cc5623af1ccb988c57fb40e14e518b307a5f567`의 bytes SHA와 7개 child manifest bytes SHA가 모두 PASS했다. 529건 분류는 reusable 4·primary review 221·prepared 151·source changed 82·quality held 71이다. 이전 `e6…` 준비물 중 입력 SHA가 같은 child는 재사용되고 새 PDF 입력 3건은 새 material로 별도 결속돼, 이전 16건 `2aa1…` child가 이 캠페인에서 sequence 3으로 이동했다. 7개 child 합계는 여전히 154건이다.
- 새 캠페인의 첫 25건 child `c4c1f12a76170bdc4a9e00afdba4488632180bfbb7862a6042651536e4f0db69`은 `not_started`, 완료 0·grant 0·`liveExecutionAuthorized=false`다. `2aa1…` 16건은 입력 material drift 0이고, 보조 GAP 사업지침서 PDF 1개가 markdown_missing이다. 공고문 누락은 이 child에 없다. 이 준비 manifest는 품질 인수·실행 승인이 아니며 exact19와 분리한다.
- 새 캠페인의 물리 입력 감사에서 154/154 target의 input/attachment material drift 0, 입력 누락 24개·영향 target 15개, 공고문 누락 3개·영향 target 1개다. 앞선 27개·17개와 비교해 3개·2개 감소했다. `--require-announcement-coverage`가 exit 2로 차단한 유일한 공고는 K-Startup `175783` 통합공고다. 안내책자 PDF, 본공고 HWPX, 본공고 PDF 세 파일 모두 cap_exceeded다. 저장 공식 payload의 신청방법·지원대상·제외대상은 모두 `각 지원사업 모집 공고문 참고`이고 정규화 benefits는 null이므로, 이 상위 목록을 개별 지원 가능한 공고로 단정할 수 없다. 대상 사업을 분리해 원문을 검수하기 전에는 매칭 가능 근거로 쓰지 않는다. 나머지 누락 21개는 매뉴얼·공간 사진·신청서·포스터 등의 후속 검수 대상으로 남긴다.
- 이 감사의 PASS는 입력 결속에 한정된다. 507건 전체의 원문 조건 의미 검수, 아스카웍스의 실제 지원 자격 판정, 신청서 field readiness, 서비스 추천 품질 인수는 완료가 아니다. exact live 모델 호출 및 서비스 DB 승격은 별도 승인 경계를 유지한다.

## 2026-09-28 matching-only 모델 전 공고문 입력 보호

- `175783`의 원문 상위 목록이 입력되지 않은 채 matching-only 모델 결과가 만들어질 수 있는 경로를 확인했다. 승인된 launch capability와 exact input SHA를 검증한 후 모델 요청 전에 attachment preparation report에서 명시적 `announcement`가 `loaded` 또는 완전한 `covered_by_children`인지 확인한다. 미로드·부분 입력이면 해당 target에서 `matching_announcement_input_missing`으로 실패하고 다음 target 격리는 기존 batch 정책에 맡긴다. 신청서·사진 등 보조 첨부의 누락만으로 전체 cohort를 멈추지 않는다.
- 새 보호 단위 테스트, input 17개 시나리오, prepared execution, launch-batch 23개, admission, matching-campaign 29개와 legacy-material 2개, 웹 typecheck, package JSON 및 diff 검증 PASS. 집계 `pnpm lab:launch:test`는 terminal repair 역사 artifact 정책과 application-only synthetic run 계약의 2건에서 FAIL했다. 변경 전 clean commit `da4bb54`를 별도 archive checkout과 동일 `spike-out`에서 실행해 같은 두 실패를 재현했으므로 이번 보호 변경에 의한 회귀 증거는 아니다. 집계 gate는 여전히 FAIL 상태로 보존한다.
- 이 코드 변경은 실행 계약을 바꾸므로 `5456…` 현재 campaign도 이전 runtime snapshot이다. 코드 커밋 후 새 campaign을 준비하고 exact 입력과 권한을 다시 확인해야 한다.

## 2026-09-28 준비 manifest의 runtime 재사용 결함

- 공고문 입력 보호 코드 `578ac0b`을 커밋·push하고 재준비한 `d0517f8878241fe0b6bd50ef8b46158e97ef8583f31ef128aace87f724240d39`의 classification `6854b56e100bec8890337a0da56870105781a3171b2065ac71fc38cc0e697507`과 7개 child bytes SHA는 모두 PASS했다. 현재 529건 분류는 reusable 4·primary review 221·prepared 154·source changed 79·quality held 71이다. 첫 25건은 `not_started`, 기존 grant 0·live authority false; 입력 감사도 154건 material drift 0·누락 24개·공고문 누락 3개였다.
- 그러나 child `0b78a2ac…` 13건의 package runtime SHA `55121604…`가 다른 6개 child의 `30aa25ba…`와 달랐다. 기존 prepared history의 `contractCompatible`은 `matching_only` 모드만 보아 과거 runtime manifest를 재사용했다. launch는 현재 package runtime과 다르면 실행 전 거부하므로, 위 `d051…` campaign도 실행 승인 대상으로 제시하지 않는다.
- prepared child 재사용 조건에 현재 package runtime·validator·prompt·model·transport·concurrency·existing-run policy를 결속하도록 수정했다. 이미 실행돼 receipt가 있는 자산의 판정과 active runtime 소유 보존은 그대로 두었다. 과거 runtime mismatch는 `source_changed`로 새 manifest에 재봉인된다. matching-campaign 30개와 legacy-material 2개 테스트, 웹 typecheck PASS. 커밋 후 현행 캠페인에서 일곱 child의 runtime SHA 일치를 재확인한다.

## 2026-09-28 현행 runtime 일치 캠페인 준비

- 코드 `89bdd05`를 커밋·push한 뒤 campaign `0d406a9d991cd047c102e000980035f99d1b0073594b180c3251e5ba219b8f4e`, classification `06164a8e2dc8c33caf2b106d5cd277ff3ef08cb4589859f0ac98b2f5d16a72f7`을 새로 봉인했다. 두 파일과 7개 child의 bytes SHA PASS. 모든 child는 `matching_only`·`claude-cli`·`claude-opus-5`·concurrency 2이고 package runtime SHA가 동일한 `30aa25ba…`다. 과거 13건 `0b78…`은 재사용되지 않고 새 13건 `58920414…`로 대체됐다. 감시 사건의 16건 `2aa1…`은 동일한 manifest SHA로 현재 campaign sequence 5에 재배치됐으며 exact19와 합산하지 않는다.
- 현재 529건 분류는 reusable 4·primary review 221·prepared 141·source changed 92·quality held 71. 일곱 child 합계 154건이다. 첫 25건 `8bfc3490…` status는 `not_started`, completed 0·grant 0·live authority false다. `claude auth status --json`은 `claude.ai/max` 로그인으로 반환됐다. 현재 campaign 전체의 물리 입력 감사도 154건 material drift 0, 누락 24개·영향 15건, 공고문 누락 3개·영향 1건이다. 세 공고문이 빠진 `175783`은 모델 전 대상별 보호로 실패 격리되며, 16건 `2aa1…`은 material drift 0·보조 지침서 1개 markdown_missing·공고문 누락 0이다.
- 이 준비물은 현재 코드와 입력 결속을 통과한 모델 무호출 범위다. exact 전체 154건의 live launch 승인은 아직 없다. 시작 전 사용자 exact 승인·grant·runtime paused/lease 확인이 필요하고, 모델 결과의 독립 검수·서비스 DB 승격·배포는 별도 단계다. `pnpm lab:launch:test` 집계의 변경 전부터 존재한 두 실패는 아직 해소되지 않았다.

## 2026-09-28 역사 launch 검증 gate 복구

- 집계 launch 테스트의 두 기존 실패를 원인별로 수정했다. 완료된 current-inventory matching-only `claude-opus-5`·`lab-deep-v28`·validator v23 receipt는 오프라인 역사 복구에서만 읽고, 현행 live material contract는 계속 거부한다. 실제 matching20의 20건 receipt에서 성공·skipped는 보존하고 모델 미착수 실패 13건만 terminal repair 후보로 고르는 테스트가 PASS했다.
- application-only는 과거 primary run의 모델·전송·프롬프트를 새 신청서 실행 계약과 비교하지 않고 exact source manifest와 비교한다. run bytes SHA·source receipt·input/attachment SHA·publishable·matching projection 검사는 유지한다. v19 완료 primary 재사용과 matching-only 부모의 application-only 후속 테스트가 모두 PASS했다.
- `pnpm lab:launch:test` 전체 PASS, 웹 typecheck PASS, 역사 matching20의 현행 live material contract 거부 회귀 PASS. 기존 역사 receipt·run 파일은 수정하지 않았고 모델 호출·서비스 승격도 없었다. 코드 커밋 후 최종 확인을 다시 수행한다.
- commit `da5ea9f`를 작업 브랜치에 push한 정확한 소스에서 `pnpm lab:launch:test`, `pnpm build:web`, `pnpm verify:package-runtime-freshness`가 모두 PASS했다. Vercel PR preview는 검사 당시 배포 중이므로 원격 PASS로 세지 않는다.

## 2026-09-28 감시 §78 인계와 독립 검수 보류 이력 복원

- 감시 사건 `7093cfbf13c5e6f79f1fe00c53794aefbb605f39ca43400214d90315432f3ce4`는 `prepared_manifest_changed` 2건이다. `2efed53ba332406d8e93b98aca6f0b4ce67ae5045ec8f1fd2b43972a3d5a0518` 25건과 `58920414a3eb8c3e89da4dec98d92fe4934fc97c932b573b1ce88a374f70e539` 13건의 bytes SHA를 이번 세션에서도 확인했다. 감시 인계상 각각 exact19와 grantId 교집합 0·결속 grant/receipt 0이며, 이 세션은 중복 ack나 모델 실행을 하지 않는다. `input_accepted`는 소유권 완료가 아니다.
- 일시 재준비 campaign `e4f1967d0eb74269bde110572e86f58b0c72a25f72a87e37a4ebafb4774b350e`에서 후보가 154→155건으로 늘었다. 추가 1건은 K-Startup `179187`, grantId `301e4b86-bc46-4c06-8ed1-6f59bf01fd9b`다. 현행 입력/첨부 SHA는 일치했지만 2026-09-25 동일 입력에 대한 독립 검수 aggregate `a9b89c4f…`가 결함 9건으로 `HOLD`를 기록했고, 별도 `independent_review_repair` manifest `2b7ce11e…`은 아직 grant/receipt 없이 준비 상태다. 이 1건을 일반 matching 재실행 후보로 넣을 근거가 없었다.
- 원인은 두 단계였다. 역사 matching-only `claude-opus-4-8`/prompt v30/validator v25 완료 receipt `b72e38a1…`가 오프라인 이력 reader에서 제외돼 더 오래된 이력을 선택했고, 이를 읽도록 보정한 뒤에도 그보다 늦게 만들어진 미실행 일반 준비 manifest `3870a03e…`이 독립 검수 보류를 덮었다. 완료 receipt의 exact 구 계약은 오프라인 소비에만 허용하고, 같은 입력의 미실행 준비물이 완료된 primary·quality-held 상태를 대체하지 않도록 했다. 현행 live material 검사는 과거 v30/v25를 거부한다. 역사 receipt나 검수 aggregate는 수정하지 않았다.
- 수정 commit `50600b1`·`a5aba59`의 회귀 검증: `launch-batch.test.ts` 23/23, `lab:matching-campaign:test` 31+2/33, `pnpm lab:launch:test`, 웹 typecheck, `pnpm build:web`, `git diff --check` PASS. 실측 재분류에서 `179187`은 `quality_held / independent_review_held / campaignEligible=false`이며 그 1건짜리 일반 child `3870a03e…`은 현재 campaign에 포함되지 않는다.
- 현행 모델 무호출 campaign `a5377289fdc9a4986042bd450b5d959e05a42228a14a4f66d1c8f8ff81ed970e`, classification `464c4cd608c037ebb7ed40b2b3d2afafbbe3f3a9960cd35a1e37f4a3a9236af9`의 bytes SHA PASS. 529건 분류는 reusable 4·primary review 221·prepared 154·source changed 79·quality held 71이다. 7개 matching-only child 25/25/25/25/25/13/16건은 전부 bytes SHA PASS, 같은 package runtime `30aa25ba…`, `claude-cli`/`claude-opus-5`/concurrency 2다. 감시 인계의 25·13건은 현행 campaign sequence 4·5에 포함된다. status는 첫 child `not_started`, 완료 0·기존 grant 0·`liveExecutionAuthorized=false`다.
- 이 campaign의 물리 입력 재감사는 154/154 material drift 0, 미입력 첨부 24개·영향 target 15개, 공고문 누락 3개·영향 target 1개다. 누락 공고문은 K-Startup `175783` 통합공고에 한정된다. `--require-announcement-coverage`는 예상대로 exit 2이며, launch 시에도 이 대상은 모델 요청 전 격리된다. 입력 감사 PASS는 원문 조건의 의미 검수나 아스카웍스 지원 가능 판정이 아니다.
- `a537…`은 grant·receipt가 없는 준비물이다. 이 사건 인계는 exact live 실행 승인, 품질 인수, 서비스 DB 쓰기 승인이 아니다. 새 exact 캠페인 범위의 사용자 승인 전 grant/launch를 실행하지 않는다. 성수 `179187`의 별도 독립 검수 보정도 이 일반 campaign과 합산하지 않는다.
- 실행 단계 검토용으로 같은 코드·현재 대상의 `--allowed-stage=launch` 범위를 모델 무호출로 별도 봉인했다. campaign `d3de7179e0fbd85cf958c0071a5ac503944c3c31b2aeb954eee685c707ad30b0`, classification `c544637976e59a7ae01d22bab256b99320874f7237ebe15d5e940d5cb093d47c`의 bytes SHA PASS. `a537…` 준비 전용 범위와 529개 ID·분류 entry·7개 child SHA/순서/건수는 완전히 같고 classification 관측 시각과 허용 단계만 다르다. 새 범위 status도 첫 25건 `8bfc349003ac8474f19fadbc524f4248ecce58b9e2890f594e4ea4f043915704`의 `not_started`, 완료 0·grant 0·`liveExecutionAuthorized=false`다. 사용자의 exact live 승인이 아직 없으므로 `--allowed-stage=launch` 봉인만으로 grant/모델을 시작하지 않는다.

## 2026-09-28 08:19 KST 재시도 영수증 이력 복원과 현행 캠페인 확인

- 2026-09-18 matching-only 100건의 원본 receipt `d98501f35bf212ae98c37d0cd693c2d140f113e2701540580659ca49cb63fa4f`는 publishable 95·failed 5였다. 같은 grant의 재시도 receipt `8272ecb90f39ec0cd88a5358bde582499764ff0a9c7f78dc35ea70b6c37552b2`는 skipped 95·publishable 4·held 1이었다. 기존 campaign reader가 마지막 receipt만 소비하여 skipped 95개를 과거 성공 결과 대신 terminal quality hold로 잘못 해석했다. 두 receipt의 target별 마지막 **non-skipped** 결과를 결합하면 publishable 99·held 1·skipped 0이다. 이 결합은 기존 immutable artifact를 바꾸지 않는다.
- 수정 `758d602`는 같은 manifest·grant·target 순서·receipt 시간 결속을 검사한 뒤 target별 유효 결과와 실제 source receipt SHA로 독립 검수 이력을 읽는다. 회귀 테스트는 원본 publishable을 retry skipped가 덮지 않는 경우, 새로운 non-skipped 결과로의 교체, grant/target 불일치 차단을 확인했다. `pnpm lab:matching-campaign:test`, 웹 typecheck, `pnpm lab:launch:test`, `pnpm build:web`, `git diff --check` PASS. 이 수정은 과거 독립 검수 자체를 통과시킨다는 뜻이 아니다.
- 새 모델 무호출 campaign `181ea87b0710b2a95ff5e9ac87dc33418a7b97ce7e5a45e1889a6589484933e2`, classification `f4763330887f26e674ae4c9b56c1505361067f12601788c0c3f06696689234a3` 및 child 7개 bytes SHA PASS. 직전 `d3de…`와 529개 target·7개 child SHA/순서/건수·분류 개수는 같다. 이력 종류만 70건이 `terminal → primary`로 바로잡혔다. 분류는 reusable 4·primary review 221·prepared 154·source changed 79·quality held 71로 변하지 않았다. 감시 §78의 25건 `2efed53…`과 13건 `58920414…`은 각각 child 4·5로 그대로 포함되며 exact19와 합산하지 않는다.
- `--status`는 첫 child `8bfc349003ac8474f19fadbc524f4248ecce58b9e2890f594e4ea4f043915704`가 `not_started`, 완료 0·기존 grant 0·`liveExecutionAuthorized=false`라고 확인했다. 물리 입력 재감사는 154/154 material drift 0, 미입력 첨부 24개·영향 15건, 공고문 누락 3개·영향 1건(K-Startup `175783`)이다. `--require-announcement-coverage`는 예상대로 exit 2다. 해당 target은 원문 없이 모델 호출하기 전에 격리해야 한다.
- 기업마당 `PBLN_000000000126531`(ICT 비즈니스 파트너십)은 같은 material의 기존 publishable 분석이 위 skipped 오류에 가려져 있었다. [NIPA 원 공고](https://www.nipa.kr/home/2-2/16934)는 ICT·AI 분야 중소·중견기업 대상과 10월 12일 14시 마감을 명시한다. 반면 [기업마당 상세](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126531)의 구조화 지원대상은 중소기업이며, 과거 독립 검수는 규모 조건 충돌을 unresolved로 지적했다. 현재 supply는 `source_review/condition_review`이며 아스카웍스 프로필의 규모도 비어 있다. 따라서 소프트웨어 사업 관련 후보 사례이지만 지금은 지원 가능·추천 가능으로 확정하지 않는다. 원문 조건 검수와 회사 규모 확인이 남아 있다.
- 이 캠페인의 221건 `primary_review_required`가 현행 원문 조건 검수 단계다. 준비물·이력 복원·물리 SHA PASS는 추천 품질 인수나 서비스 승격 근거가 아니다. 사용자 exact live 승인 전에는 grant/launch를 실행하지 않으며, 승인 범위가 확정되면 당시 신청기간·material·runtime·lease를 다시 검사한다.

## 2026-09-28 08:29 KST 현행 조건 검수 221건의 과거 분석 분해

- 현행 classification `f476…`의 `review_current_conditions` 221건을 동일 코드의 검증된 launch history reader로 읽기 전용 재집계했다. 이력은 primary 97·legacy material 48·terminal 11·무이력 60·legacy 2·prepared 3이다. primary 97건의 독립 검수는 held 95·pending 2로, 공급 단계의 `source_review/condition_review`만 보고 재사용 가능 또는 신규 분석 필요라고 판단할 수 없다.
- primary 97건의 현재 `prepareLabAnalysis` 입력/첨부 SHA를 과거 분석과 exact 대조했다(97/97 조회 성공). held 95건 중 동일 material 39·변경 material 56, pending 2건 중 동일 material 1·변경 material 1이다. `PBLN_000000000126531`은 동일 material이지만 독립 검수에서 규모 조건 충돌이 unresolved라 held다. 단지 원문이 같다는 이유로 PASS나 추천 대상으로 올리지 않는다.
- 동일 material held 39건 가운데 2026-09-18 원본 100건 독립 검수 aggregate `4f62c7cd9f2702c1ff9270274d5bb798e56489ccb5b2bc5f347c8d5bf29c602a`의 명시적 defect와 결속된 15건을 확인했다. 15건의 모델 무호출 `independent_review_repair` prepare는 drift 제외 0이었다. 그러나 그중 7건은 PDF/ZIP 텍스트 입력이 누락됐고, 3건은 `announcement` 누락이다. 15건 준비물은 입력 완전성이 부족한 7건의 실행 근거로 사용하지 않는다.
- 입력 첨부가 전부 `loaded|covered_by_children`이고 과거와 material이 같은 defect 8건만 별도 재준비했다. original sequence `3,7,22,63,65,72,74,91`, manifest `ba06aab4a4c02afcf89e1a9ea51b3df034ffe6fc471b24abd603ce53d6d92291`의 bytes SHA PASS, 제외 drift 0, `matching_only`/`claude-cli`/`claude-opus-5`/concurrency 2, grant·receipt 0, `liveExecutionAuthorized=false`다. 이 artifact는 기존 154건 일반 campaign과 별도인 독립 검수 결함 보정 준비물이며 exact19와 합산하지 않는다. 사용자 exact live 승인과 실행 직전 신청기간·material·runtime·lease 재확인 전에는 모델을 시작하지 않는다.
- ICT `126531`의 sequence 54는 aggregate에서 defect가 아닌 unresolved이므로 `independent_review_repair` selector가 정확히 거부했다. 더 많은 모델 호출로 자동 해결할 경로가 아니라 공식 원문 간 규모 범위의 수동 판정·검수 경로가 필요하다. 56건 변경 material 역시 같은 입력의 보정 대상으로 보내지 않고 현재 원문 변경 검수로 남긴다.
