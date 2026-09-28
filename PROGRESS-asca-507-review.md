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
- 동일 material held 39건 가운데 2026-09-18 원본 100건 독립 검수 aggregate `4f62c7cd9f2702c1ff9270274d5bb798e56489ccb5b2bc5f347c8d5bf29c602a`의 명시적 defect와 결속된 15건을 확인했다. 15건의 모델 무호출 `independent_review_repair` 준비 manifest `4459b164f8798db1fc42a220a4c5e8a7e74f9099a457b56c9b804eef1da1fcc0`은 bytes SHA PASS·drift 제외 0이다. 그러나 그중 7건은 PDF/ZIP 텍스트 입력이 누락됐고, 3건은 `announcement` 누락이다. 15건 준비물은 입력 완전성이 부족한 7건의 실행 근거로 사용하지 않는다.
- 입력 첨부가 전부 `loaded|covered_by_children`이고 과거와 material이 같은 defect 8건만 별도 재준비했다. original sequence `3,7,22,63,65,72,74,91`, manifest `ba06aab4a4c02afcf89e1a9ea51b3df034ffe6fc471b24abd603ce53d6d92291`의 bytes SHA PASS, 제외 drift 0, `matching_only`/`claude-cli`/`claude-opus-5`/concurrency 2, grant·receipt 0, `liveExecutionAuthorized=false`다. 이 artifact는 기존 154건 일반 campaign과 별도인 독립 검수 결함 보정 준비물이며 exact19와 합산하지 않는다. 사용자 exact live 승인과 실행 직전 신청기간·material·runtime·lease 재확인 전에는 모델을 시작하지 않는다.
- ICT `126531`의 sequence 54는 aggregate에서 defect가 아닌 unresolved이므로 `independent_review_repair` selector가 정확히 거부했다. 더 많은 모델 호출로 자동 해결할 경로가 아니라 공식 원문 간 규모 범위의 수동 판정·검수 경로가 필요하다. 56건 변경 material 역시 같은 입력의 보정 대상으로 보내지 않고 현재 원문 변경 검수로 남긴다.
- 8건 repair manifest와 일반 154건 campaign의 grantId 교집합은 0이다. 준비 8건의 원본 분석·검수 결함만 대상으로 삼고, 일반 campaign의 새 공고 분석과 중복 실행하지 않는다.
- `pending` 2건은 같은 역사 receipt `0129b8cf…`의 sequence 25·26이며 기존 독립 검수 manifest는 20개 packet만 포함해 두 sequence를 검수하지 않았다. sequence 25는 현행 input/attachment가 이미 변경됐다. sequence 26(`PBLN_000000000126416`)은 현행 material이 같아 gpt-6-sol 독립 검수 packet을 오프라인 준비하려 했지만 `matching_projection_runtime_binding_mismatch`로 정확히 거부됐다. 과거 matching projection과 현행 runtime 사이를 근거 없이 승계하거나 과거 파일을 수정하지 않는다. 현행 계약으로 새 분석을 봉인하거나 역사 projection 검증 경로를 별도 설계·검증해야 하는 미완료 blocker다.

## 2026-09-28 현행 조건 검수 재현 가능 감사

- 일회성 진단을 읽기 전용 CLI `pnpm lab:matching-campaign:review-audit -- --classification=<SHA>`로 고정했다. 봉인된 classification bytes SHA·canonical 계약을 읽고, 검증된 launch history와 현재 `prepareLabAnalysis`의 input/attachment SHA를 비교한다. 대상별 비정상 입력은 `error`로 남기고 exit 2로 분리한다. 공고·첨부·회사 데이터 쓰기와 모델 호출은 없다.
- `f4763330887f26e674ae4c9b56c1505361067f12601788c0c3f06696689234a3` 실측에서 221/221 조회·오류 0이다. legacy material 48, terminal 11, 무이력 60, legacy 2, prepared 3, primary held/same 39·held/changed 56·pending/same 1·pending/changed 1로 앞선 독립 임시 감사와 정확히 일치했다. 이는 역사·material 분류이며 원문 의미 검수나 독립 검수 PASS를 새로 만들지 않는다.

## 2026-09-28 08:43 KST 독립 검수 보정 15건의 입력 누락 경로 확인

- 동일 material 결함 보정 준비물 `4459b164…` 15건을 현재 `prepareLabAnalysis`로 읽기 전용 재점검했다. 입력이 불완전한 7건은 모두 BizInfo 첨부 `markdown_missing`이며, 이 중 3건에는 `announcement`가 포함된다. 앞서 분리한 8건 `ba06aab4…`은 이 7건을 포함하지 않는다.
- 위 7개 sourceId에 한정한 `backfill:bizinfo-attachments --reprocess-missing-markdown` dry-run은 7건 로드, 재처리 후보 2건·첨부 2개를 반환했다. 후보는 `PBLN_000000000126497` 및 `PBLN_000000000126585`의 ZIP이다. 그러나 `126585`의 실제 누락 입력은 별도 **공고문 PDF**여서 이 ZIP 재처리만으로 해결되지 않는다. `126497` 1건만 누락 첨부 자체가 ZIP이다. 이 조사는 모델 호출·R2/DB 쓰기 없이 수행했다.
- 입력 report를 파일별로 대조하면 누락 11개 중 ZIP 1개를 제외한 10개는 **exact PDF 원본은 있으나 markdown이 없는** 상태이고 `pdf_text_or_ocr`·`requiresSourceWrite=true`로 분류된다. 7건 전체를 백필 명령 하나로 복구할 수 없다. PDF 텍스트/OCR의 별도 복구와 실제 텍스트·material 재검증이 필요하며, 기존 15건 manifest에 새 입력을 혼합하거나 실행 대상으로 확대하지 않는다.

## 2026-09-28 08:58 KST PDF 원본 복구 가능성 검증과 exact 쓰기 경로

- 누락 PDF가 있는 BizInfo **6개 공고·10개 파일**을 기존 `listPdfTextOcrRecoveryCandidates`가 정확히 찾았다. 나머지 1개 공고 `126497`은 PDF가 아니라 ZIP 누락이므로 이 복구 범위에서 제외한다. R2 원본 10/10 SHA가 DB 기록과 일치했고, 로컬 `pdftotext`는 7개에서 본문을 추출했다. 3개는 이미지 전용이다.
- 기존 PDF 복구 코어와 같은 160dpi 렌더·macOS Vision 조합으로 이미지가 있는 총 14페이지를 읽기 전용 사전 검증했다. 10개 파일 전부 OCR 경로가 현재 confidence 0.6·페이지 상한 20 계약을 통과했다. 이 수치는 문자 추출 가능성의 증거일 뿐 원문 의미 정확도나 독립 검수 PASS가 아니다. PDF 임시 파일은 사전 검증 후 삭제했다.
- source manifest `4459b164…`의 현재 input/attachment SHA, 공고 상태·지원 종료 시각, surface 원본 키·PDF SHA를 묶은 별도 source-only 계획 `e12dada0023d31984956e88ff393fb62a10b006e592422f3f151f5c9e62f3d44`를 `spike-out/asca-test-20260927/same-material-defect10-pdf-recovery-plan.json`에 봉인·readback PASS했다. 대상은 6개 공고·10개 PDF, R2/DB 텍스트 산출물 쓰기만이며 모델 호출·서비스 승격·배포는 범위 밖이다.
- `lab:matching-pdf-source-recovery -- --plan=<path>`는 source manifest bytes/canonical SHA와 subset material, 현재 공고·입력·PDF 바이트를 재검증하는 읽기 전용 preflight로 PASS했다(6/10, drift 0). `--write`에는 exact plan·receipt 경로·확인값이 필요하고, 동일 receipt 경로의 로컬 lock을 선점한 뒤 실행한다. 결과 receipt는 생성 후 SHA readback을 검증하며, 중간 오류로 receipt가 없으면 lock을 남겨 자동 중복 실행을 막는다. 확인값 없는 쓰기 시도는 exit 1이며 receipt/lock 생성 0을 확인했다. 계약 테스트 3/3, 기존 PDF 복구 테스트, 웹 typecheck, package runtime freshness, diff 검사 PASS. 이번 코드 변경 뒤 기존 모델 실행 package runtime SHA `30aa25ba…`는 동일하다.
- 프로젝트 `AGENTS.md`의 운영 데이터 변경 경계에 따라 위 exact source-only 계획의 사용자 승인 응답을 요청했다. 아직 R2/DB 복구 쓰기·모델 실행·추천 승격을 하지 않았다. 승인 후에도 실행 직전 preflight 재검증, receipt와 입력 변화·남은 누락 확인이 필수다.

## 2026-09-28 09:13 KST ZIP 내부 모집 포스터 누락 원인과 변환 경로

- 나머지 BizInfo `PBLN_000000000126497`의 보관 ZIP은 SHA 검증 PASS, 5개 entry(신청 관련 HWPX 4·모집 포스터 PNG 1)다. 포스터에는 모집 기간과 연구소기업 자격 조건이 있으므로 비중요 이미지로 면제할 수 없다. 126497을 PDF 10개 source-only 계획에 섞지 않은 이유다. 실제 포스터의 로컬 macOS Vision OCR 사전 검증은 514자·confidence 0.773으로 현행 0.6 임계값을 통과했다.
- 기존 ZIP child 추출은 HWPX만 선택해 PNG를 누락했다. OCR 어댑터가 명시된 경우에만 PNG/JPEG도 child로 추출·변환하고, ZIP parent의 완전성 검증에는 이미지 entry도 material로 포함하도록 보정했다. 이미지 child가 없으면 parent는 여전히 보류되고, 정확한 child 원본·hydrated OCR 텍스트까지 확인될 때만 parent를 `covered_by_children`으로 다룬다.
- 실제 보관 ZIP 바이트와 로컬 OCR을 쓰기 없는 저장소 모형에 통과시킨 결과 parent 1·child 5를 모두 아카이브 대상으로 만들고 child 5/5 변환 성공·실패 0이었다. 이는 원본 바이트 기반 변환 실험이며 운영 R2/DB 쓰기나 공식 URL 재다운로드 검증은 아니다. ZIP 변경에 대한 관련 archive/container/input 테스트, 웹 typecheck, package runtime freshness PASS이며 모델 package runtime SHA `30aa25ba…`는 동일하다.

## 2026-09-28 09:25 KST ZIP 공식 바이트와 매칭 상태를 포함한 실행 범위 수정

- BizInfo `126497`의 현행 공식 첨부 URL을 다시 다운로드해 보관 ZIP과 바이트 길이 1,996,092 및 SHA `e66f3603…`가 정확히 일치함을 읽기 전용으로 확인했다. 기존 backfill은 `--sourceIds`·1건 상한에서 ZIP 1개만 선택했다. exact 파일명·SHA 옵션을 추가하고, 공식 다운로드 SHA가 다르면 첫 R2 쓰기 전 거부하도록 했다. 잘못된 파일명 dry-run은 exit 1, 잘못된 SHA 테스트는 R2 쓰기 0이다.
- 더 중요한 범위 발견: PDF 6건과 ZIP 1건 모두 현재 `visible`이고 각 1건의 `conditional` match_state가 있다. ZIP 1건은 확정 dedup component 1개 grant·match_state 1행·기존 criterion 11행·promoted criterion 0행이다. 일반 BizInfo 첨부 발행은 grant/raw/criteria를 갱신하고 source revision 변경 시 match_state를 무효화·재계산한다. 이를 생략한 첨부행만의 ZIP source-only 쓰기는 기존 visible 매칭을 낡은 상태로 둘 수 있으므로 수행하지 않는다.
- 앞서 요청한 ZIP source-only 계획 `945c0ec6…`은 **실행에 사용하지 않는다**. 발행·기존 매칭 최대 1행 재계산까지 포함한 새 exact 계획 `f3b1c42eb5c7d0d912fac260001371080033d9258b7307d79c75fc05588e0096`을 `spike-out/asca-test-20260927/same-material-defect-126497-zip-publisher-plan.json`에 봉인·readback PASS했다. 실행 CLI는 source manifest/input/attachment SHA, 현재 공고·지원 종료·공식 URL/bytes, ZIP material child 5개, dedup component 1·match_state 1·criterion 11·회사 ID 집합 SHA를 읽기 전용으로 재검증한다. preflight PASS, 계획 계약 테스트 2/2 PASS다.
- 프로젝트 `AGENTS.md`의 exact 운영 변경 경계에 따라 새 ZIP v2 범위 승인을 요청했다. 기존 v1 승인만으로는 실행하지 않는다. PDF 6건 계획 `e12dada0…`도 아직 쓰기 전이며, 이 복구는 document artifact 입력만 추가하고 모델 분석·승격은 별개로 유지한다.
- ZIP v2 실행 경로는 첨부 선택 `1/1`·공식 URL·원본 SHA를 다시 확인하고, 바이트가 다르면 첫 R2 쓰기 전에 거부한다. publisher 영향 범위를 별도 읽기 전용으로 예행한 결과 dedup component 1·대상 회사 1·planned match_state 1·candidateComplete true였다. 영수증에는 실제 revision/무효화·재계산 수, child 변환 수, ZIP parent 입력 결과를 봉인한다. 확인값 없는 `--write`는 영수증·lock 생성 0으로 거부됐다. ZIP 계획 계약 테스트 2/2, 첨부 아카이브 gate, BizInfo batch 테스트, ingestion publish gate, 웹 typecheck PASS. 이 검증은 실제 운영 쓰기·모델 결과·추천 품질을 대신하지 않는다.

## 2026-09-28 ZIP 발행 직전 영향 범위 재검증

- 감시 §78의 25건 `2efed53b…`·13건 `58920414…`은 이미 별도 캠페인 child 4·5에 결속된 준비물이며 이번 알림은 새 승인으로 취급하지 않았다. exact19 재실행·중복 ack·모델 호출은 하지 않았다.
- ZIP v2의 별도 읽기 전용 preflight를 현재 상태에서 재실행해 동일 계획 `f3b1c42e…`, 원본 1개, material child 5개, 영향 grant 최대 1개, 기존 match_state 1행을 확인했다. 현행 `visible/open` 및 신청 종료 시각도 확인한다.
- 이전 preflight와 실제 발행 사이에 대상 범위가 바뀌는 위험을 줄이기 위해, publisher의 단일 grant 트랜잭션에서 publication lock 취득 뒤 grant ID·상태·신청 종료, confirmed dedup component, criteria/promoted 개수, match_state 회사 ID 집합 SHA를 exact 계획과 재대조한다. 다르면 첫 DB mutation 전에 실패하고, 이 exact 경로는 serializable isolation을 사용한다. ZIP batch에서 해당 결속을 끝까지 전달한다. 실제 발행 뒤 성공 판정에는 무효화·재계산 각 1행을 요구한다. 이 검사는 트랜잭션 전 수행하는 R2 쓰기를 되돌리지는 못하므로, 발행 실패 시 receipt 대신 lock을 보존하고 수동 조사해야 한다.
- 변경 후 정상·매칭 회사 drift·promoted criterion drift 트랜잭션 테스트, `verify:ingestion-publish`, `verify:grant-attachment-archive` 27/27, ZIP 계획 계약 2/2, 웹 typecheck, package runtime freshness, `git diff --check` PASS. 운영 DB/R2 write와 모델 실행은 승인 응답 전이다.

## 2026-09-28 당일 마감 원본 복구 preflight 날짜 판정 보정

- 현재 캠페인 `181ea87b…`의 154건을 DB와 읽기 전용으로 재감사했다. material drift 0, 미입력 첨부 24개·15개 target, 공고문 누락 3개·1개 target(`kstartup/175783`)으로 직전 수치와 같다. 이 감사 결과는 의미 검수나 추천 품질 인수가 아니다.
- PDF 6건 계획의 새 preflight가 `bizinfo/126586`을 drift로 잘못 거부했다. DB 조회 결과 이 공고는 `open/visible`이고 저장된 마감일과 계획 결속이 동일한 `2026-09-28T00:00:00Z`였다. 감사 시각 09:20 KST는 **마감 당일**인데 복구 CLI가 UTC 시각 비교로 09:00 KST 이후를 마감으로 오판한 것이다. 현행 제품 모집기간 계약은 저장 UTC 날짜를 KST 달력일로 해석하고 마감일 전체를 포함한다.
- PDF·ZIP 복구 preflight 및 ZIP publisher의 exact 트랜잭션 guard에 동일한 `classifyNoticePeriod`를 적용했다. 공고의 `open/visible`, exact 마감일, 현재 KST 기간을 모두 검증한다. PDF receipt의 완료 조건도 후보·성공 건수가 계획한 10개와 정확히 같아야 하도록 좁혔다. 수정 후 실제 현재 PDF 계획은 6개 공고·10개 PDF 원본 SHA 검증까지 읽기 전용 PASS, ZIP 계획은 원본 1개·child 5개·기존 매칭 1행 범위로 읽기 전용 PASS다. 두 쓰기 계획의 승인 범위는 변하지 않았으며 실행하지 않았다.

## 2026-09-28 현재 아스카웍스 공급·가상 답변 재측정

- 저장된 회사 프로필을 수정 없이 읽고 동일 시각(09:24 KST)의 제품 공고 universe와 재매칭했다. universe 1,502건 중 원문 조건 `verified`는 22건, `discovery`는 1,480건이다. verified 22건에서 실제 저장 프로필은 eligible/recommendable 0·conditional 14·ineligible 8이다. 미확인 `size=중소기업`을 비영속으로 가정하면 eligible/recommendable 1·conditional 13·ineligible 8이며, 그 1건은 인도 BTS 전시회다. 실제 회사 규모 확인이나 지원 자격 확정이 아니다.
- 같은 저장 프로필로 discovery 포함 전체 universe를 `buildTeaser` 읽기 전용 평가한 결과 eligible/recommendable 0, conditional 1,494, ineligible 8, reviewNeeded 1,499였다. 이 중 1,480건은 discovery 원문 검수 전 재고여서 `reviewNeeded`를 지원 가능 후보 또는 품질 통과량으로 해석할 수 없다. 기본 표시 8개에서는 discovery 1개와 verified 7개가 선택됐다. 서버의 확인 질문·노출 주석을 적용하기 전의 core 평가이므로 실제 브라우저 카드 UX 검증을 대신하지 않는다.
- 같은 평가에서 다음 프로필 질문 축은 `size`였으며 일반 `oneAnswer`는 1건, exact 현행 질문 결속을 요구하는 `oneQuestionAway`는 0건이었다. 따라서 답변 하나가 결과를 바꿀 수 있는 경로는 있지만 현재 사용자 화면에서 정확히 한 질문 뒤 확정될 공고라고는 아직 단정할 수 없다.
- 실제 서비스와 같은 확인 질문 context를 읽기 전용으로 로드해 verified 22건에 결속했다. 역사/일반 anchor는 25개지만 현행 원문·serving run·v2 3상태 계약까지 통과한 anchor는 0개이고, 서버 주석 뒤에도 `oneQuestionAway=0`이다. 인도 BTS 후보(`126455`)의 단일 미확인 hard trace는 `size / company_profile_missing / company_profile`이며 공고별 확인 질문 수는 0개다. `oneQuestionAway`는 현행 criterion에 결속된 per-notice 확인 질문 약속이므로 이를 일반 기업규모 입력에 재사용하지 않는다. 다음 프로필 질문 `size`와 비영속 가정 시 추천 변화는 별도 사실로 유지한다.

## 2026-09-28 PR 미리보기 브라우저 검증 경계

- draft PR #18의 `f28dd31` 체크는 Vercel/Preview Comments PASS이고 GitHub deployment 원장에도 해당 SHA의 Preview 배포가 생성됐다. 코드가 같은 앞선 `78dae17` 배포는 success였다. 해당 미리보기 앱 URL을 격리된 `agent-browser` 세션에서 열자 애플리케이션 대신 `vercel.com/login`으로 리다이렉트됐다. 따라서 배포 PASS는 확인했지만 아스카웍스 로그인 화면·매칭 카드의 브라우저 UAT는 **미실행**이다. 브라우저 세션은 닫았다.
- 앱의 개발 서버는 실행 중인 포트가 없어 프로젝트 규칙대로 시작하지 않았다. 미리보기 로그인은 대화형 인증 경계이고, PR의 공개 접근 설정을 임의로 바꾸지 않는다. 새 문서 커밋마다 Vercel 미리보기 작업이 새로 생기므로 다음 근거는 가능한 한 한 번에 기록·커밋한다.
- 공급 병목은 현행 프로필의 미확인 기업 규모와 원문 조건 검수가 끝난 공고의 매우 작은 수가 함께 만든다. 이를 확인 답변 없이 임의 저장하거나 discovery 1,480건을 자동 추천으로 올리지 않는다. 사용자 대상 실제 추천 품질은 분석 receipt·독립 검수·서비스 연결 후 다시 측정해야 한다.

## 2026-09-28 공급 판정과 campaign 준비 경로 재검토

- 과거 통합 계획의 planner/executor 분리 지적을 현재 코드에서 다시 확인했다. `prepareMatchingInventoryCampaign`은 실제 `assessPublishedGrantSupply`의 계획과 evidence SHA를 읽고, `await_approved_model_run`인 `condition_analysis`만 물리 입력 준비에 넣는다. 자산 조회 불가·기존 분석 검수·재사용·승격 준비 단계는 모델 대상에서 제외된다. child 준비 직전 공급 evidence SHA를 재조회하고, 현행 지원기간·원문 결속은 `prepareExactInventory` 및 target 착수 검증에서 현재 시각으로 다시 확인한다. 이 옛 지적만으로 추가 코드 수정은 정당화되지 않는다.
- 현재 154건의 공고문 입력 누락 1건(`kstartup/175783`)은 launch의 모델 요청 전 보호로 대상별 실패 격리되지만, 준비 모집단에는 남는다. 통합공고를 실제 개별 지원사업으로 분리하지 않은 상태에서 이를 추천 가능한 분석 공급으로 세지 않는다. campaign 전체의 실행 권한은 여전히 없으며, 이 검토는 모델 호출·운영 쓰기 없이 코드와 기존 감사 산출물만 읽었다.

## 2026-09-28 09:37 KST 공고문 미입력 준비 대상 제외

- `prepareCurrentEligibleMatchingTargets`에서 이미 조립한 입력의 명시적 공고문 첨부가 `loaded|covered_by_children`인지 확인하도록 했다. 미로드·부분 입력 또는 진단 보고서 부재는 `announcement_input_missing`으로 target만 격리하고 `recover_source`를 지정한다. 신청서 등 보조 첨부 누락은 이 검사만으로 격리하지 않는다. 기존 launch 직전 공고문 보호도 유지한다.
- 코드 commit `87f501c`의 matching campaign suite 33/33·legacy history 2/2, `lab:launch:test`, 웹 typecheck, package runtime freshness, diff 검증 PASS. 테스트는 공고문 누락·보조 첨부 누락·진단 보고서 부재를 분리했다.
- 09:37:13 KST 현재 읽기 전용 DB와 로컬 준비물로 campaign `196b61ef2b4c8ec5de5899df71225e84415aea5061d34e0ed99ceecc15ca02ca`, classification `baf2d0f796fd049a2fb9319c65920ad6e556c692586d9688a3fa62f1e7d2664b`을 봉인했다. 두 파일 bytes SHA PASS. 모집단 529건의 분류는 reusable 4·primary review 221·prepared 153·source changed 79·quality held 72이며, `175783`은 `preparation:announcement_input_missing`/`recover_source`/campaignEligible false다. §78의 25건 `2efed53b…`·13건 `58920414…`은 새 index에도 동일 child SHA로 남는다. 새 첫 child `c4c1f12a…`는 `not_started`·기존 grant 0·live authority false다.
- 새 campaign 전체 153건 물리 입력 감사 산출물은 `spike-out/asca-test-20260927/campaign-153-input-audit-20260928.json` (bytes SHA `e7bb3aabbe2dd5231173c472420cd127fa993f96c28993d54a375553417f7dae`)이다. 153/153 material drift 0, 미입력 보조 첨부 21개·14개 target, **명시적 공고문 누락 0**으로 `--require-announcement-coverage` PASS. 이는 원문 조건 의미 검수·모델 품질·서비스 추천 인수가 아니다. 모델 grant/launch, 서비스 DB/R2 쓰기, 승격은 실행하지 않았다.
- 위 `196b61ef…` index는 `allowedStage=prepare`여서 실행 계획으로 사용할 수 없다. 같은 commit·현행 모집단에서 `allowedStage=launch`인 별도 index `61f836e3689d54dbaaf9d93113ad4aa0d271bc1252433e5ee53feb9b9b2bf50a`, classification `09ff3ecb8123589025c4e3bcd151f2630c00c69d9d5a1b537bdefab12c652b0f`을 로컬에 봉인했다. 두 파일 bytes SHA PASS, 두 index의 child manifest SHA **집합 7개가 동일**하고 153건·분류 개수도 동일하다. child 순서만 달라 새 첫 child는 24건 `727ba4a4…`이며 status `not_started`·기존 grant 0·live authority false다. `allowedStage=launch`는 준비 가능한 최대 단계 표기이며 사용자 exact 승인이나 실행 자체가 아니다.

## 2026-09-28 09:44 KST 공고 파일명 역할 보정과 현행 152건

- 직전 153건의 보조 첨부 누락 21개 중 BizInfo `PBLN_000000000119234`의 `…시행 공고.pdf`는 이름에 공고가 명시돼 있지만 역할 진단이 `unknown`이었다. 공고문이라는 *파일명 역할*을 끝의 `공고.pdf|hwp|hwpx|doc|docx|zip`까지 확장했다. 실제 입력 조립 테스트는 이 PDF가 미입력일 때 `announcement`로 표시되고 모델 전 공고문 보호가 거부함을 확인한다. `input.test.ts` 17개 시나리오·웹 typecheck·package runtime freshness·diff 검증 PASS, 코드 commit `8806cd6`.
- 현행 launch 가능 준비 index `8f469e82ae35b9ec7ed7a441c86761f4b1b8b1f125f0e1fcbb23785c0f6d70fb`, classification `c060349271c86a5388e2d89e17ff83bd3cac3381751e8e0a522c02480a7a32e4` bytes SHA PASS. 529건 중 prepared 152·quality held 73이며 다른 분류는 reusable 4·primary review 221·source changed 79로 동일하다. 새로 격리된 `119234`는 `preparation:announcement_input_missing`/`recover_source`다. 7개 child는 전부 `matching_only`·`claude-cli`·`claude-opus-5`·concurrency 2·동일 package runtime SHA이고, 첫 child status는 `not_started`·기존 grant 0·live authority false다. §78의 25건·13건 child SHA는 이 index에서도 유지한다.
- 152건 물리 입력 감사 `spike-out/asca-test-20260927/campaign-152-input-audit-20260928.json` (bytes SHA `e3573e21820a039d5bdd8061ada70789378d9839f14947e35c2c1e743db85fd0`)은 material drift 0·명시적 공고문 누락 0, 미입력 보조 첨부 20개·13개 target이다. `--require-announcement-coverage` PASS는 파일명으로 역할이 확인된 공고문 범위의 물리 입력만 증명한다. `사업지침서`, 창업기업 확인 유의사항처럼 자격 의미를 담을 수 있는 다른 첨부의 내용을 검수한 결과가 아니며 152건을 의미 검수 완료나 추천 가능량으로 세지 않는다.
- 앞서 질문한 `196b61ef…`의 **153건** live 범위는 이 역할 보정으로 현행 실행 대상이 아니다. 정확한 최신 범위의 별도 승인 전에는 어느 child도 grant/launch하지 않는다. 운영 서비스 쓰기·회사 답변 저장·승격·배포도 하지 않았다.

## 2026-09-28 09:55 KST 빈 변환 본문 보호와 입력 한도 실측

- 첨부 markdown의 R2 로드·SHA 검증이 성공해도 frontmatter 제거 후 본문이 비면 기존 로더는 `loaded`로 기록했다. 이는 모델이 공고문을 보지 못했는데 공고문 입력 gate가 통과하는 경로였다. `empty_markdown`을 명시적 `unavailable`로 기록하고 exact PDF/HWP 원본 재변환 경로를 표시하도록 보정했다(commit `059bd4a`). 공백 본문 공고문이 모델 전 gate에서 거부되는 실제 조립 테스트, matching campaign suite 33/33·legacy 2/2, 웹 typecheck·package runtime freshness PASS. 이전 152건 재감사에서는 이 상태가 실제로 발생한 대상 0, material drift 0·누락 20개로 확인됐다.
- K-Startup `176076`의 누락 HWP 2개는 변환 결과가 없는 것이 아니라 12만 자 입력 한도에서 각각 부분·전체 미투입이었다. 읽기 전용 30만 자 실험에서 실제 전체 입력은 125,782자이고 두 HWP가 모두 로드됐다. 13만 자 전체 감사에서는 해당 target과 `177957` 두 target만 material SHA가 바뀌며, 누락 첨부는 20→18개였다. 12만 6천 자에서도 `176076`은 모두 포함되고 `177957`의 리플렛·서식 3개 누락은 그대로라, 더 작은 12만 6천 자를 기본값으로 선택했다(commit `ab31e97`). 분석용 입력이 6천 자 늘어날 수 있어 해당 대상의 모델 지연 영향은 아직 측정하지 않았다.
- 새 기본값 기준 campaign `fcd0db56f5ea5a32246cd0c2c4f05cc06c953d8f4f4862ac404b96bc87cd1fd9`, classification `367b768b2886a3995ccb5503cb20da6c6651d5abf7483590f42633fd8ccc8c57`은 bytes SHA PASS. 529건 중 prepared 150·source changed 81·quality held 73·primary review 221·reusable 4다. 두 건이 prepared→source changed로 이동한 이유는 이번 입력 한도에 따른 exact input/attachment SHA 변화(`changed:input+attachment`)이며, 운영 원문이 변경됐다고 단정하지 않는다. 7개 child 합계 152건은 `matching_only`·CLI Opus 5·동시성 2·동일 package runtime이고 첫 child `not_started`·기존 grant 0·live authority false다. 모델 무호출 로컬 준비이며 §78의 25건·13건 child SHA는 그대로다.
- 새 152건 물리 감사 `spike-out/asca-test-20260927/campaign-152-cap126k-input-audit.json` (bytes SHA `afc81ae6397b43e7ed824de13290d4cb244f8312d301e86e9a130c8467adcaf1`)은 material drift 0·명시적 공고문 누락 0, 남은 미입력 보조 첨부 18개·12개 target이다. `PBLN_000000000120498`의 사업지침서 PDF는 exact R2 원본 SHA `3977b95f…`와 바이트 일치, 1,080,792바이트에서 `pdftotext -layout` 48,621자를 읽기 전용 확인했다. 미입력 PDF 6개는 현행 document surface와 원본 SHA가 결속된 복구 후보로 조회됐지만, 이 조사는 변환 markdown을 운영 R2/DB에 발행하지 않았다. 사업지침서 등 남은 첨부의 자격 의미는 아직 검수되지 않았다.
- 앞선 153건·152건 준비 index는 새 입력 계약의 현행 승인 대상으로 사용하지 않는다. 새 `fcd0…`도 exact 사용자 live 승인·grant 전이며, 검수되지 않은 보조 문서를 추천 가능 근거로 승격하지 않는다.

## 2026-09-28 10:00 KST 남은 PDF의 실제 원본 확인과 source-only 준비

- 새 152건의 미입력 18개 중 PDF `markdown_missing` 6개는 현재 document surface와 보관 원본이 1:1 결속됐다. 원본을 R2에서 **읽기만** 하여 6/6 bytes SHA를 대조하고 로컬 `pdfinfo`/`pdftotext -layout`로 각각 페이지·텍스트 길이를 측정했다: `179292` 2쪽/31자(이미지 중심), `123797` 31쪽/8,056자, `121389` 29쪽/10,564자, `177844` 13쪽/87,501자, `121107` 133쪽/160,374자, `120498` 47쪽/48,621자. 이 값은 변환 품질·자격 문장 의미 검수의 대체 증거가 아니다. 대형 133쪽 매뉴얼을 자동으로 모델 입력에 붙이지 않는다.
- 자격 근거 가능성이 큰 BizInfo `PBLN_000000000120498`의 현행 입력은 10,361자이며, 미입력 `(사업지침서) 2026년 GAP 안전성 분석 지원.pdf`의 보관 원본은 1,080,792바이트·SHA `3977b95f…` 일치, 로컬 텍스트 48,621자라 현행 126,000자 입력 한도 내 추가 가능성이 있다. 실제 출처 의미와 지원 자격은 아직 검수 전이다.
- 이 한 PDF만 위한 기존 v1 source-only 복구 계획 `spike-out/asca-test-20260927/current-campaign-120498-pdf-recovery-plan.json`을 현재 child manifest `2aa1b23d…`, grant·신청 종료·input/attachment SHA, document surface·원본 SHA에 결속했다. 내부 plan SHA `e5b2910d6cac99083f6bdcd14e57a55d8330b0fa5cf7cdbfc043a1693e532229`, 파일 bytes SHA `a4facc25a3bc62ccd231c62d12efdd5fe69def1a56e43df3d0ad99d9d82655be`. 기존 복구 CLI의 읽기 전용 preflight는 `READY_FOR_SOURCE_RECOVERY_APPROVAL`, 원본 바이트 1/1 검증, 모델 호출·DB/R2 쓰기 0으로 PASS했다. 프로젝트 AGENTS.md의 exact 운영 쓰기 경계에 맞춰 별도 승인 응답을 요청했으며, 실제 source write·모델 실행은 하지 않았다.

## 2026-09-28 10:10 KST 감시 §78 재인계와 아스카웍스 우선 검수

- 감시 fingerprint `7093cfbf13c5e6f79f1fe00c53794aefbb605f39ca43400214d90315432f3ce4`의 25건 `2efed53b…`·13건 `58920414…`은 앞서 별도 campaign child로 기록했다. 이번 재인계도 prepared 사건이며 exact19의 19 terminal과 합산하거나 grant/launch 승인으로 전환하지 않는다. 중복 ack·모델 호출은 하지 않았다.
- 현행 classification `367b768b…`의 `review_current_conditions` 221건을 읽기 전용으로 재감사했다. `matching-review-backlog-cap126k.json` bytes SHA `ca7fd39591dfafaf96e3233290e51cf14b9598a6baa5350d17b4a2ba6a34eca4`, 오류 0. 이력은 legacy material 48, primary held/same 39, primary held/changed 56, terminal 11, no local lab history 60, legacy 2, prepared 3, primary pending/changed 1, pending/same 1이다. 이 분포는 자동 재사용 또는 일괄 재실행 근거가 아니다.
- 아스카웍스 저장 프로필의 업종은 광고·미디어콘텐츠·응용 SW이고 지역은 서울이다. 현행 152 child를 서비스 매칭 경로로 읽으면 152건 모두 `discovery`여서 조건부 후보 152·추천 가능 0·관련성 점수 null이다. 이는 오늘 적격 공고가 0건이라는 증거가 아니라 검수 공급이 아직 완료되지 않았다는 제품 상태다. 제목의 AI·SW 등 신호만으로 24건이 걸리지만 자격 검증은 아니다.
- 실제 모델 입력 3건을 현재 작업 브랜치에서 재조립하여 `campaign-152-cap126k-input-audit.json`과 input/attachment SHA 각각 3/3 일치시켰다. 감사 증거는 `inspect-three-correct-worktree.json` bytes SHA `a8391e69b4a6c048608a53f88c7657fff7c06a37d3486f8a94c86e1a6882bd19`. 안산 ICT·SW 컨설팅(`PBLN_000000000123753`)은 원문에 안산시 관내 창업기업·7년 이내라는 조건이 있어 서울 프로필의 일반 SW 업종만으로 추천할 수 없다. K-Global 해외진출(`176968`)은 ICT·디지털 제품과 해외진출 준비 증거가 필요해 회사 답변이 더 필요하다. 핀테크 투자 밋업(`179012`)은 핀테크 진출 의사가 있으면 검토할 수 있으나 현재 회사 프로필로 이를 확정할 수 없다.
- 최초 임시 점검 스크립트가 공유 `spike-out` symlink를 따라 다른 checkout의 구 코드로 해석되어 2건의 SHA 차이를 만들었다. 이 차이는 **원문 변경 증거가 아니며**, 위 현재 브랜치 재조립 3/3 일치로 바로잡았다. 운영 입력 변경·권한·모델 품질 주장을 이 잘못된 비교에 근거하지 않는다.
- 기업마당 [공식 상세](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000120498)에서 `PBLN_000000000120498`은 GAP 안전성 분석 지원으로 확인됐다. 앞 절에서 이를 아스카웍스 우선 source-only 복구 대상으로 본 판단을 철회한다. 준비 계획 파일은 보존하지만 관련성 낮은 이 운영 쓰기를 우선 실행하지 않는다. 152건 전체의 자격 의미 검수·독립 품질 인수, 아스카웍스 실제 추천 가능량, 서비스 화면 UAT는 여전히 미완료다.
- 위 3건 중 지역 조건이 맞지 않는 안산 공고를 제외하고 K-Global `176968`·핀테크 밋업 `179012`의 **2건만** 별도 `matching_only` 실행 준비했다. 모델 무호출 manifest `160e9d6fba02ccafa02c5c3435cef6d394b858cd86b1470217f828ff7ef43979`, inventory `14d5a54047e7a6f715c33bfbab854023ab4f60485bc295a8c6919bf390f9e9c0`은 각 파일 bytes SHA와 일치한다. CLI Opus 5·동시성 1·신청서 제외, 원문 input/attachment SHA는 직전 감사와 2/2 일치한다. 결속 grant/receipt/status artifact는 0이며 이 준비물은 사용자 exact 승인·grant 전에는 실행 권한이 없다. 기존 152건 campaign child나 exact19를 다시 실행하지 않는다.
- 2건의 원문 기반 독립 기대 판정: K-Global은 AI·ICT·디지털 제품/서비스 **보유**, 시장 출시·영업활동, 해외 IP·해외 전시회 경험·해외 법인·수출/해외 판매 중 1개 이상, 제외 사유 부재를 각각 확인해야 한다. 현재 아스카웍스의 SW 업종 답변만으로 위 사실을 충족했다고 볼 수 없으므로 `conditional`/질문 필요가 상한이다. 핀테크 밋업은 핀테크 기업 또는 핀테크 영역 확장을 고민하는 스타트업을 대상으로 하며, 회사의 진출 의사가 현재 답변에 없으므로 역시 질문이 필요하다. 원문 점검 산출물 `asca-two-source-conditions.jsonl`의 두 input SHA는 manifest와 일치한다. 이 기대 판정은 사용자 자격 확인이나 모델 출력의 품질 인수가 아니다.

## 2026-09-28 10:22 KST 익명 결과의 검수 후보 표시 순서

- 저장된 아스카웍스 회사 계정을 읽기 전용으로 다시 계산했다(`asca-owned-teaser-current-readonly.json`, bytes SHA `e54ff2e8917571c0ea7f547fa0078d7587373684a23b1e99632a99b4108415ca`). 제품 universe 1,502건 중 verified 22·discovery 1,480, 실제 프로필은 추천 가능 0·조건부 1,494·탈락 8이다. 다음 질문은 기업규모이며 `oneAnswer=1`, `oneQuestionAway=0`이다. 기본 8개 카드 중 첫 자리에 원문 미검수 농식품 공고가 오고, 검수된 인도 BTS 전시회가 두 번째였다.
- `selectTeaserDisplay`는 검수 전 공고를 최소 1개 보여 주려고 첫 generic review 자리로 앞당겼다. 이를 결과 선택 뒤 마지막 generic review 자리로 옮겼다. 현행 원문에 결속된 정확한 확인 질문과 답변 하나로 판정 가능한 검수 후보의 우선순위는 유지하고, discovery 노출 1개도 보존한다. 실제 계정 재평가(`asca-owned-teaser-after-order.json`, bytes SHA `b5f16bc216ca865625a7328662d4b9a7429ed323f3201a0d6f1a64bccbe33fbe`)에서 인도 BTS가 첫 카드, discovery는 여덟 번째이고, 추천·질문·집계 수는 동일하다. 이는 추천 가능량을 늘리는 수정은 아니다.
- core `match-explanation` 회귀, core typecheck, `pnpm test:matching-unit`, 웹 typecheck, diff 검증 PASS. 프로젝트 전용 개발 서버가 없어 브라우저 UAT는 미실행이다. 감시 §84의 fingerprint `7ebb2774029c62ac29fe777971922ecf3dc163bd36c5dfdcba3db145772858d4`는 위 2건 manifest `160e9d6f…` 준비 알림이다. 감시 세션만 ack했고, 이 세션은 grant/launch를 하지 않았다. 이번 core 변경은 package runtime을 바꾸므로 **이전 exact 2건 manifest의 live 승인 질문은 현행 실행 대상으로 사용하지 않는다**. 코드 커밋·package build 후 새 manifest로 재봉인해야 한다.
- 순서 수정 commit `4c62bbc`에서 `pnpm build:packages`와 `pnpm verify:package-runtime-freshness` PASS, 새 runtime SHA `15f195f3…`를 확인했다. 동일 2개 grant·같은 current input/attachment SHA를 새 `matching_only` manifest `5f90a58bb156bbf6586c8d2bca84c60cf0e567c89449f47e9239836587f99630`과 inventory `1c82081e76876b5c80b54c7f88ca1c234ef85c67f1c3a9d43f499bcb098a31a8`로 재봉인했고 두 파일 bytes SHA PASS다. 결속 grant/receipt/status는 여전히 0이다. 앞선 `160e…` 승인 질문은 무효라고 명시하고 최신 SHA의 최대 2건 승인 질문을 새로 보냈다. 답변 전 모델 실행·운영 쓰기는 없다.
- 같은 코드에서 `pnpm build:web` PASS(Next/Turbopack NFT 추적 경고 1건), 빌드 후 `verify:package-runtime-freshness` PASS와 정확한 package runtime SHA `15f195f3bb6a3e02c60fcdded892aece654e5e454b328a1a10b118250e50b4e1` 재대조 PASS다. 빌드 과정에서 추적 파일 변경은 없었다. 이 빌드는 로그인 후 카드의 실제 브라우저 UAT나 모델 결과 품질을 증명하지 않는다.

## 2026-09-28 10:35 KST 감시 §84 후속과 기존 분석 재사용 검증

- 감시 fingerprint `7ebb2774…`는 이전 `160e9d6f…` 준비 알림, `b9ca511f…`는 현행 `5f90a58b…` 준비 알림으로 분리했다. 두 번째 알림의 bytes SHA와 2건 `matching_only`·exact19 교집합 0·grant/receipt 0은 감시 세션의 인계 내용이다. 이 세션에서는 기존 로컬 `5f90a58b…` 준비물과 비교했고, 감시 ack나 launch를 중복 실행하지 않았다. 두 사건 모두 사용자 live 승인으로 해석하지 않는다.
- BizInfo `PBLN_000000000126531`의 [NIPA 원 공고](https://www.nipa.kr/home/2-2/16934) 첨부 PDF를 로컬에 읽기 전용으로 보관했다. 파일 bytes SHA `f18bd693c31f9b7f523774976b8dd1d1852b8766f9a8e53896c3cd7dbb9e10da`는 현재 분석 입력에 보관된 모집공고 PDF SHA와 동일하다. PDF 본문에는 ICT·AI 분야 **중소·중견기업** 대상과 ICT·AI·디지털 제품/솔루션/서비스 모집분야가 있다. 기업마당 구조화 대상의 `중소기업`과 충돌한다는 기존 독립 검수 지적은 불변 aggregate에서 unresolved 상태다. 주관기관 원문이 결속됐다는 확인만으로 이를 PASS로 바꾸거나 추천 대상으로 승격하지 않았다.
- `PBLN_000000000122516`(침해사고 예방을 위한 취약점 점검 무료 지원)의 현행 입력/첨부 SHA는 과거 publishable 분석과 각각 일치한다. 과거 `deep-v29` release manifest에는 이 공고의 조건 3개와 legacy 질문 1개가 있고 `approval.json`, canary/full verification PASS artifact가 있다. 그러나 현재 읽기 전용 DB snapshot은 category B, 질문 수요 2개, 검수된 v2 질문 0개다. blocker는 `active_question_source_stale`, `active_question_unreviewed`, `active_question_v2_missing`, `eligible_question_missing`; 공급 단계는 `await_approved_release`다. 과거 release의 canary 대상도 이 공고가 아니며, 현재 `lab:release --inspect --launch-receipts=d1b9d9e8…`는 `promotion_duplicate`로 거부됐다. 따라서 과거 release를 새 질문 발행 권한으로 재사용하지 않는다.
- 같은 공고의 현행 criterion은 원문 `도메인 또는 IP를 보유한 기업 및 비영리기관`(required)과 `특정 AS 및 보안 전문 기업 지원 불가`(exclusion)를 포함한다. legacy 질문 1개는 후자에 붙어 있고 저장 답변 0건이다. `pnpm prepare:legacy-question-migration-review`를 read-only DB/로컬 파일 출력으로 실행해 현재 shadow `658140c5…`, manifest `2f189bb5…`, 23개 packet을 만들었다. 이 공고 packet의 content SHA는 `e731a001…`, bytes SHA는 `69f3ab59…`이며 authority는 `human_review_required`/migration·release·live write false다. 이관할 질문의 사람 검수 결정과 누락된 도메인/IP 질문의 별도 원문·질문 검수가 모두 필요하다. 23건 묶음을 임의로 승인하거나 서비스 DB를 쓰지 않았다.
- 위 조사에서는 모델 호출·운영 쓰기가 0건이었다. 추가 코드 변경도 없으므로 이번 항목의 검증은 현행 DB repeatable-read 조회, 불변 파일 bytes SHA, 원문 PDF 텍스트 대조, `lab:release --inspect`의 fail-closed 결과다. `lab:release --inspect --series=deep-v29`는 해당 exact target의 terminal receipt 부재로 거부됐다. 이 결과는 기존 승인 release의 소급 부정을 뜻하지 않고, 현행 신규 release 입력으로 그 series를 사용할 수 없다는 뜻이다.

## 2026-09-28 단건 레거시 질문 검수 경로

- 전체 23개 질문 결정이 한꺼번에 필요했던 검수 준비 CLI에 `--grant-id=<UUID>`를 추가했다. 현재 공개·접수 공고만 scoped shadow에 포함하고, 지정 ID의 부재·형식 오류·중복/상한을 fail-closed한다. 기존 전체 묶음 경로는 유지한다. 해당 보안 점검 공고를 현행 DB read-only로 준비한 결과 단건 manifest `f535a1905eb7f5c7ba5b2f2851e1f9a9e4a28a54e204f01d62f07e1aef806607`, shadow `7072787d58480e9354db4b69bb5badab653804ce44d970a2015d3ce02f4cb899`, packet 1개, 답변 보존 검수 0개다. 전체 묶음의 같은 후보와 `candidateSha256=813fe872…` 일치, packet content SHA는 shadow 범위 차이로 달라졌다.
- 실제 존재하지 않는 UUID로 단건 CLI를 호출했을 때 `현재 공개·접수 범위에 없습니다`로 거부됨을 확인했다. shadow/review/draft 관련 suite 6/8/7 PASS, 전체 `pnpm test:grant-product-readiness`, 웹 typecheck, package runtime freshness, diff 검증 PASS. 모델·서비스 DB 쓰기는 0건이다. 실제 사람의 review decision set은 아직 없고, 기존 release의 중복 승격 보호 및 도메인/IP 신규 질문 부재도 그대로 남는다. 단건 packet 생성만으로 서비스 추천 가능량이나 질문 발행이 늘었다고 기록하지 않는다.

## 2026-09-28 보안 점검 공고 원천 의미 재감사

- [KISA 원 공지](https://boho.or.kr/kr/bbs/view.do?bbsId=B0000132&menuNo=205022&nttId=72056&pageIndex=1)와 [기업마당 상세](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000122516)를 다시 열었다. 기업마당의 이미지 PDF를 읽기 전용으로 내려받아 1쪽 전체를 렌더링해 직접 확인했다. bytes SHA `ea333dc38019cbdff5099c551a38e33829c998d4e3af4aaaaabe356dbe0c616e`. 원문은 도메인 또는 IP 보유를 요구하고 **특정 업종 및 보안 전문 기업**을 제외한다. 대표 도메인 확인이 안 되거나 타 기업 도메인이면 점검 불가하다는 신청 조건도 명시한다.
- 기존 publishable run의 exclusion source span은 `특정 AS 및 보안 전문 기업 지원 불가`이며, 모델의 criterion note에는 `AS` 의미가 스캔 품질 때문에 확정되지 않는다고 스스로 적혀 있다. 그럼에도 axis는 `condition_found`, 독립 검수는 해당 criterion을 `correct`로 기록했고 이 run은 과거 release에 포함됐다. 원본 이미지는 `AS`가 아니라 `업종`으로 판독된다. 따라서 이전 절의 단건 packet은 **이관 승인 후보가 아니라 criterion 수리 후보**로 취급한다. 기존 보안 전문 기업 질문을 이관하거나 `도메인/IP` 질문만 추가해 이 공고를 추천 가능으로 올리면 알려지지 않은 특정 업종 제외 조건을 빠뜨릴 수 있다.
- 이 사례는 입력 PDF의 OCR 손상과 이미 알려진 불확실성을 판정·독립 검수·승격이 함께 놓친 시스템 결함의 증거다. 현행 run·release 원장은 수정하지 않았고 서비스 DB·모델 호출도 하지 않았다. 후속은 원천의 업종 선택지까지 확인한 정확한 제외 범위 수리, 필요한 경우 원천 제공기관 확인, 그 뒤 질문 계약 재검수와 별도 release 경로 검증이다. 단건 질문 이관 기능의 성공을 이 공고의 품질 통과로 해석하지 않는다.
- 기존 로컬 LabRun 1,812개 중 `OCR|판독|스캔 품질|원문/근거 불명확·손상` 표현이 required/exclusion criterion의 note/value/span에 나온 것은 9개 run·10개 criterion이다. 그중 4개 criterion은 과거 release manifest에 포함돼 있다(현재 활성 서비스와 같은 뜻이 아님). 이는 키워드 기반 **조사 목록**이며 나머지 run의 원문 품질을 보증하지 않는다. 보안 점검 공고 외 세 release 포함 criterion은 각각 문맥과 공식 원문을 별도로 확인해야 한다. 현행 validator가 criterion 안의 스캔 판독 불확실성을 `condition_found`와 함께 통과시키는 경로를 좁은 대표 회귀로 고정하고, 원천 이미지/텍스트 대조 또는 사람이 확인한 수리 전에는 확정 자격으로 승격되지 않게 하는 공통 보호가 필요하다.

## 2026-09-28 판독 불가 자격 조건의 신규 발행 차단

- 확인된 결함의 재발을 막기 위해 새 release admission 공통 검사 `hasUnreadableEligibilitySource`를 `analysis-launch`와 역사 `deep-repair` 승격 판정에 연결했다. `required`·`exclusion` criterion의 note가 OCR·스캔·이미지 원문을 `판독 불가` 또는 `해독 불가`로 명시하면 독립 검수가 `correct`여도 `eligibility_source_unreadable`로 `held` 처리한다. 대체 원문이 확인된 경우에는 기존 run의 문구를 묵인하지 않고 그 근거를 결속한 수리 run을 사용해야 한다. 명시적 판독 불가가 아닌 일반 의미 불확실성은 이 정규식이 판단하지 않는다.
- 실제 `PBLN_000000000122516`의 보관 LabRun을 새 검사에 읽기 전용으로 통과시켜 exclusion criterion index 2가 hit임을 확인했다. 로컬 `run-*.json` 1,812개 중 criteria 배열이 있는 1,474개를 같은 함수로 검사한 hit는 이 run 1개다. 나머지 338개는 이 검사 모집단이 아니며, hit 0은 원문 정확성 PASS가 아니다. 앞 절의 넓은 9-run 조사 목록은 별도 의미 검수를 유지한다.
- `pnpm lab:release:test` 전부 PASS, 웹 typecheck PASS, `pnpm verify:package-runtime-freshness` PASS, `git diff --check` PASS. 새 synthetic 회귀는 판독 불가 exclusion의 `held`와 일반 OCR 보정 note의 비차단을 확인한다. 이 변경은 승격 판정 코드이며 모델 package runtime/validator/prompt를 바꾸지 않는다.
- 감시 fingerprint `b9ca511f1e3ade1dc483e20ab521de0255a71176dcf9ab40e9547797c21dfb54`의 현행 manifest `5f90a58bb156bbf6586c8d2bca84c60cf0e567c89449f47e9239836587f99630` bytes SHA PASS. manifest execution은 `matching_only`·CLI Opus 5·동시성 1·대상 2건이다. 현행 monitor state는 `prepared`, grant/receipt/status 모두 null, pending·inspectionError null, 해당 fingerprint acknowledged다. 감시 세션의 ack는 실행 승인이나 품질 인수가 아니다. `160e…` 과거 준비물이나 exact19와 합산·중복 실행하지 않는다.
- 이 admission은 **신규 release만** 막는다. 과거에 이미 적용된 KISA release/활성 질문을 소급 변경하지 않는다. 원천의 특정 업종 제외 의미 수리, 질문 검수, 기존 서비스 노출 위험 판단과 별도 운영 변경 승인은 남아 있다. 이번 변경에서 모델 호출·운영 DB/R2 쓰기·배포는 없다.

## 2026-09-28 기존 발행 공고 노출 위험과 격리 준비

- 변경 후 운영 DB를 `SET TRANSACTION READ ONLY`로 재조회했다. `PBLN_000000000122516`(grant `5e476aa3-9a2e-4710-8ded-9611b3e5e0dc`)은 `open/visible`, `apply_end=2026-12-11T00:00:00Z`다. `analysis_lab_promotion_items`에는 `applied` 1행, `match_state`에는 `conditional` 1행, 질문은 v2가 아닌 legacy 1행이다. 현재 `grant_criteria`의 exclusion은 `특정 AS 및 보안 전문 기업 지원 불가`, `needs_review=false`다. 이 실측은 신규 release admission만으로 기존 노출이 사라지지 않음을 확인한다.
- 격리 변경의 exact 범위는 위 grant **1행의** `serving_state visible → suppressed`다. 트랜잭션에서 grant ID·source/source_id·현행 `visible/open`·현재 exclusion span·적용 release 1건과 예상 매칭 1행을 재대조한 뒤 1행만 갱신하고 readback한다. release·criterion·question·match_state 원장은 유지한다. 현재 서비스 `grantServingVisiblePredicate` 계약은 suppressed 공고를 일반 목록·상세·활성 후보·전이 이벤트에서 제외한다(`grantServingVisibility.test.ts` PASS). 이는 임시 노출 격리이지 원문 수리나 자격 판정 완료가 아니다. 운영 DB 변경은 AGENTS.md 별도 승인 경계라 exact 1건 승인 질문을 비동기로 보냈다. 응답 전 쓰지 않는다.
- 넓은 OCR/불확실성 조사 목록 중 다른 과거 승인 release 두 건도 확인했다. `PBLN_000000000123800`은 OCR의 2단 표 병합을 스스로 기록했으나 해당 criterion을 `other/text_only`와 트랙별 조건 note로 보존했고, `PBLN_000000000118133`은 특정 시험 트랙의 등록 전제를 `other/text_only`로 보존했다. 둘 다 현재 `open/visible`, `conditional` 매칭 각 1행이다. 이번 KISA의 명시적 `판독 불가`·잘못된 `AS` 사례와 동일하게 자동 격리할 증거는 아직 없다. [123800 공식 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000123800), [118133 공식 공고](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000118133)의 본문을 열어 지원 분야·지역을 대조했으며, 첨부 원문 전체의 트랙별 의미 검수는 미완료다. 일반 OCR 단어가 있다는 이유로 두 공고를 품질 PASS 또는 오류 확정으로 판정하지 않는다.

## 2026-09-28 분석 처리 시간 재측정

- 로컬 `spike-out/analysis-lab/**/run-*.json` 1,812개에서 시작 시각 2026-09-01 이후, `claude-opus-5/claude-cli`, `primaryValidationOutcome=publishable`, 유효한 `durationMs` 조건의 **run 788개**를 읽기 전용으로 집계했다. 이는 고유 공고 수가 아니라 실행 횟수다. run 지연 중앙값 162초·p90 405초·p99 640초, 출력 토큰 중앙값 16,619·p90 38,001, 입력 문자 중앙값 4,601·p90 15,704였다. 표본 내 출력 토큰과 지연의 Pearson 상관은 0.68, 입력 문자와 지연은 0.371이다. 인과관계나 신규 모델 성능 보증으로 해석하지 않는다.
- primary pass 1회/수리 0회 591개는 지연 중앙값 147초·p90 312초, pass 2회/수리 1회 178개는 231초·511초, pass 3회/수리 2회 19개는 411초·615초였다. 현재 152건 준비 묶음을 모델 실행으로 확대하기 전에 exact 2건 파일럿에서 실제 시간·출력 토큰·원문 의미·독립 검수 품질을 함께 측정하는 순서가 합리적이다. 하지만 현행 2건 manifest는 grant/receipt가 없는 준비물이며 사용자 exact live 승인 전 실행하지 않는다.

## 2026-09-28 승격 우회 경로 봉쇄

- 새 판독 불가 조건 보호는 `analysis-launch`·`deep-repair`의 readiness에 있었지만, 일반 사람/감사 release의 `planGrantPromotion`과 이미 봉인된 일반 release가 `lab:promote --write` 직전에 실행하는 `verifyPromotionSourceArtifact`에는 없었다. 일반 경로로 새 plan을 만들거나 과거 plan을 그대로 쓰는 우회를 막기 위해 공통 검사를 두 지점에도 연결했다. `analysis-launch`·`deep-repair` 전용 source verifier는 기존 readiness를 다시 계산하는 경로임을 확인했다.
- 보관된 실제 KISA `run-2026-09-01T030253.051Z-286bdc`를 새 공통 계획 함수에 직접 넣으면 `자격 조건 원문 판독 불가`로 거부됐다. 같은 run을 일반 source 재검증에 넣으면 `{ok:false, changed:["eligibility_source_unreadable"]}`로 거부됐다. synthetic 회귀는 사람 검수 여부와 관계없이 exclusion의 판독 불가가 plan 작성 및 기존 sealed release 검증을 막는지 확인한다.
- `pnpm lab:promote:test`, `pnpm lab:release:test`, 웹 typecheck, `git diff --check` PASS. 이 변경은 release 경계만 수정하며 모델 prompt·validator·package runtime은 변경하지 않는다. 과거 적용된 운영 DB row는 자동 수정되지 않으므로 위 1건 격리 승인 대기는 그대로다.

## 2026-09-28 운영 API 분석 release 경로의 동일 차단

- 운영 API 딥분석은 `deep-analysis-normalized-output-v2`를 R2에서 봉인해 release plan을 만든다. 신규 plan은 앞 절의 `planGrantPromotion` 공통 검사에 도달하지만, 이미 봉인된 release의 `verifyDeepAnalysisPromotionSourceArtifact`는 종전에는 output SHA·source/current input만 재검증했다. 현행 normalized output 계약으로 다시 파싱하고 required/exclusion의 명시적 원문 판독 불가를 검사해 `eligibility_source_unreadable` drift로 반환하도록 보강했다. 파싱 실패는 `output_contract`로 차단한다.
- API normalized output에서도 audit `concur` 상태의 판독 불가 자격 criterion이 `buildDeepAnalysisPromotionPlan`을 통과하지 못하는 회귀를 추가했다. `pnpm verify:deep-analysis-contract`, `pnpm lab:release:test`, `pnpm lab:promote:test`, 웹 typecheck와 diff 검증 PASS. 이는 운영 worker를 켜거나 배포한 증거가 아니다. 운영 main worker는 기존 `observe_only` 경계를 유지하고, 로컬 현행 2건 manifest의 모델 계약도 바꾸지 않는다.

## 2026-09-28 원문 판독 실패의 primary 단계 보류

- 기존 KISA run은 자격 제외 원문을 `OCR 손상으로 판독 불가`라고 스스로 기록했는데도 `primaryValidationOutcome=publishable`로 종결됐다. release 차단은 서비스 발행을 막지만 검수 공급량과 재시도 판단의 과대평가를 남긴다. validator v27에 `eligibility_source_unreadable` 증거 오류를 추가해 `required`·`exclusion` criterion note의 명시적 판독 불가를 `evidenceGrounded=false`로 분류한다. 그 오류가 있으면 다른 교정 가능 오류가 함께 있어도 같은 손상 입력으로 repair를 반복하지 않고 target을 `held/deferred`로 종결한다. 새 원문이 확보되면 새 input/manifest의 분석을 사용해야 한다.
- synthetic validator 회귀는 계약 형식은 유효하되 증거가 불완전한 상태, mixed issue에서도 hold인 상태를 확인했다. `runValidatedLabPrimary` 회귀는 모델 호출 1회·repair 0회·`held/deferred`를 확인했다. `pnpm verify:deep-analysis-contract`, `pnpm lab:launch:test`, `pnpm lab:matching-campaign:test`(33+2), 웹 typecheck, package runtime freshness와 diff 검증 PASS. 실제 새 모델 품질 평가는 아직 없다.
- **material validator가 v26→v27로 바뀌었으므로** 앞의 2건 `5f90a58b…`와 152건 준비 child는 현행 live 승인 범위로 사용하지 않는다. 변경을 커밋한 뒤 현재 입력/validator에 결속된 exact 2건만 우선 재준비하고 SHA·대상·grant/receipt 유무를 검증한다. 역사 manifest/receipt는 수정하지 않는다.

## 2026-09-28 validator v27 기준 아스카웍스 2건 재준비

- validator v27 수정은 `9441fa0`에 커밋·push했다. 앞선 일반 `lab:launch:prepare-current`는 두 ID의 기존 준비 이력을 발견해 `current inventory에 과거 이력이 포함됐습니다`로 거부됐다. 이 실패에서는 새 manifest가 생기지 않았다. 봉인된 classification `367b768b2886a3995ccb5503cb20da6c6651d5abf7483590f42633fd8ccc8c57`을 canonical bytes/SHA 검사로 읽어 두 target 모두 `prepared_not_started`, `campaignEligible=true`임을 확인한 후 매칭 campaign 전용 `prepareMatchingCampaignLaunch`로 재준비했다.
- 새 manifest `16433fff8b5efec316afa50592498f8f515010800d92ecc5e7d6fb5fdd760f48`, inventory `ada5d4bfee2b806c5df796938b76c65425a158730fbac970db8b9d870beb1ea2`의 파일 bytes SHA가 각각 파일명과 일치한다. 대상은 K-Startup `176968`(`9a00a2f9-cc4a-4426-a309-921b36fb32b6`)과 `179012`(`0ab7a287-8c48-4b87-ae46-9b2d8a5929f5`) 두 건, `matching_only`·CLI Opus 5·동시성 1·신청서 제외·validator v27·package runtime `15f195f3…`이다. 두 input/attachment SHA는 classification과 일치한다. 준비 시 모델 호출·서비스 쓰기 0, `liveExecutionAuthorized=false`; 결속 grant/receipt/status 검색 결과 0이다.
- 일반 campaign 준비 경로의 공급 계획 검사를 별도로 읽기 전용으로 재실행했다. 두 건 모두 `await_approved_model_run`이고 현행 공급 evidence SHA가 classification과 정확히 일치했다. PR #18의 Vercel check와 Preview Comments는 `SUCCESS`다. 이는 실제 브라우저 UAT나 분석 품질 검증이 아니다. 앞의 `5f90a58b…` 및 `160e9d6f…` 승인 질문·감시 ack를 새 v27 manifest의 실행 승인으로 이월하지 않는다. exact manifest 범위 승인과 grant 전에는 live 모델을 실행하지 않는다.

## 2026-09-28 사업지침서 미입력의 모델 착수 차단

- 152건 물리 입력 감사의 누락 18개 중 BizInfo `PBLN_000000000120498`의 `(사업지침서) 2026년 GAP 안전성 분석 지원.pdf`는 `unknown`으로 분류되어 명시적 공고문 입력 gate를 통과할 수 있었다. 이 파일명은 자격·지원 범위의 공식 지침을 가리키므로 `announcement` 역할 단서에 `사업지침서`를 추가했다. 역할은 입력 완전성 판정에만 쓰고 자격 사실로 승격하지 않는다.
- 현행 DB/R2를 읽기 전용으로 조립한 해당 공고의 지침서는 `unavailable/markdown_missing`, 별도 모집 공고 HWP는 `loaded`다. 수정 후 `assertMatchingAnnouncementCoverage`는 대상만 `matching_announcement_input_missing`으로 거부한다. 파일명 기반으로 다른 누락 첨부의 의미까지 확정하지 않으며, 지침서 원본 텍스트 복구·원문 검수는 별도 과제다.
- 아스카웍스 2건 `176968`·`179012`의 현재 input/attachment SHA는 `16433fff…` manifest와 각각 일치하고 입력 gate도 PASS다. `input.test.ts`, announcement gate 테스트, matching campaign 33+2, 웹 typecheck, package runtime freshness, diff 검증 PASS. 모델 호출·서비스 쓰기 0. 이 수정만으로 새 2건의 입력·실행 계약이 바뀌었다는 증거는 없다. exact live 승인 응답 전에는 grant/launch하지 않는다.

## 2026-09-28 campaign 직접 준비의 공급 결속 통합

- 일반 campaign entrypoint는 child 준비 직전 `await_approved_model_run` 공급 단계와 classification evidence SHA를 다시 확인했으나, 공개 `prepareMatchingCampaignLaunch` 직접 호출에는 그 검사가 없었다. 앞의 2건 직접 재준비는 별도 수동 공급 대조가 PASS했지만 호출자마다 이를 기억해야 하는 구조였다. 공통 exact 공급 판정을 준비 함수 안에 넣고 R2/DB 자산 읽기는 기존과 같은 16건 단위로 제한했다. terminal repair의 기존 공급 검사는 같은 판정 함수를 공유한다.
- 회귀는 exact evidence·단계 drift·대상 수 누락을 분리해 확인했다. `pnpm lab:matching-campaign:test` 34+2, `pnpm lab:launch:test`, 웹 typecheck, package runtime freshness와 diff 검증 PASS. 이 변경은 준비 admission이며 이미 봉인된 `16433fff…`의 두 입력 SHA·모델/validator/package 계약이나 live 권한을 바꾸지 않는다. 서비스 DB/R2 쓰기·모델 호출 0이다.

## 2026-09-28 target 착수 시점의 공급 단계 재확인

- 준비 이후 다른 검수·발행 자산이 생기면 동일 원천 SHA라도 `await_approved_model_run`이 더는 필요한 다음 작업이 아닐 수 있다. matching campaign 정책의 target 착수 검사에서 현행 원천·신청기간 검증 다음에 공급 판정을 다시 읽고, exact grant 1건의 `await_approved_model_run/condition_analysis`일 때만 모델 착수를 허용하도록 했다. 다른 current inventory 정책의 착수 계약은 유지한다. 공급 판정 변경·누락은 해당 target의 착수를 거부하며 기존 receipt를 수정하지 않는다.
- synthetic 회귀는 정상 단계, `ready` 변경, `condition_review` 변경, 결과 누락, 일반 inventory 비적용을 확인했다. `pnpm lab:launch:test`, 웹 typecheck, diff 검증 PASS. 봉인 inventory `ada5d4…`의 아스카웍스 우선 2건을 현행 DB/R2와 새 함수를 통해 읽기 전용으로 각각 재검증한 결과 둘 다 preflight PASS다. 이는 live 모델 실행·독립 검수·추천 품질 인수가 아니다.
- `pnpm build:web` PASS, 빌드 뒤 package runtime freshness PASS. Turbopack NFT 경고 2건은 모두 기존 `ingest-bizinfo` → `grantSupply` → `run-store` import trace의 전체 프로젝트 파일 추적이며 컴파일·typecheck를 실패시키지 않았다. 이 빌드는 브라우저 UAT나 공급량 개선의 증거가 아니다.

## 2026-09-28 14:10 KST 아스카웍스 실제 답변 철회 경로

- 감시 fingerprint `b9ca511f…`는 `5f90a58b…`의 **과거 v26 준비물** 알림이다. 기존 기록·ack와 분리된 새로운 실행 권한은 없다. 현행 v27 `16433fff…`도 아래 core package 변경 이후에는 material runtime이 달라져 live 실행 대상으로 사용할 수 없다. 두 준비물 모두 exact19의 19 terminal과 분리한다.
- 저장된 `(주)아스카웍스` 소유권을 운영 DB에서 읽기 전용으로 확인하고, 제품의 `MATCH_DISCOVERY_CANDIDATES_ENABLED=true` 조회를 재현했다. 1,502개 노출 후보에서 추천 가능 0, `needsProfileInput=1`, `oneAnswer=1`, `oneQuestionAway=0`; 인도 BTS `PBLN_000000000126455`가 첫 카드다. 기본 CLI 환경의 discovery 플래그 없이 본 101건은 제품 설정과 다른 조회이므로 공급량 결론에 사용하지 않는다. 실제 저장 규모는 null이다.
- 현행 인도 BTS 공고의 검수된 7 criterion을 그대로 읽어 메모리에서만 `size=중소기업`을 자가신고 confidence 0.6으로 가정했다. 이전에는 `조건부/추천0 → eligible/추천1 → 모름/추천1`이어서, 후속 “잘 모르겠어요”가 과거 자가신고 규모를 남겨 추천을 되살리는 결함을 확인했다. core의 unknown 전환에서 해당 축의 사용자 값·evidence·confidence·목록 완전성을 제거하고 공식 원천값은 유지했다. 숫자 구간 답변도 이전 정확 수치를 지워 구간으로 다시 평가하게 했다. 수정 후 같은 실제 공고는 `조건부/추천0 → eligible/추천1 → 조건부/추천0`, 최종 size null이다. 이는 메모리 계산이며 **아스카웍스 실제 규모 확인이나 서비스 DB 쓰기, 실제 추천 1건 달성**은 아니다.
- `applyCompanyProfileAnswer`의 격리 runtime 저장·재조회 회귀에서 중소기업 답변 뒤 추천1, 모름 뒤 추천0, 새 조회도 추천0 및 unknown 상태를 확인했다. `question-answer-state` 단위 테스트, `pnpm test:profile-answer-consistency`, `pnpm test:matching-unit`, core·web typecheck, `pnpm build:packages`, `pnpm build:web` PASS. 격리 runtime은 PostgreSQL `match_state` writer를 실행하지 않으므로 그 영속 상태는 미검증이다. 실제 계정·브라우저 UAT도 미실행이며 사용자 규모를 임의 저장하지 않았다.
- 다음 live 파일럿은 **현재 package runtime SHA로 재봉인한 새 exact manifest**가 필요하다. 과거 SHA 승인 질문을 새 범위로 간주하지 않는다. 별도 KISA 1행 격리와 원문 파일 복구도 운영 쓰기 승인 대기 상태다.

## 2026-09-28 14:12 KST 변경된 package runtime의 exact 2건 재준비

- 답변 철회 수정 commit `445b62b` 기준 package build와 freshness PASS. 봉인 classification `367b768b…`의 같은 두 grant를 현재 공급 판정·원문 결속을 다시 거쳐 새 `matching_only` manifest `84bf20ea392c791f49b245ea538fa27f39b9799341ac422604cbd9afc923a588`, inventory `26e064997a9be0ebd119b080750e0bd991df6f3a82360ea0e1d72e560f1f10e0`로 준비했다. 두 파일의 bytes SHA 일치, input/attachment SHA 각각 직전과 일치, validator v27, package runtime `d52420f3c4861c6c4b6c4e44ec7f765776dd710604c08228248b1c3003c6b231`, CLI Opus 5·동시성 1·신청서 제외다. 이 manifest 결속 grant/receipt/status는 0이고 준비 시 모델 호출·서비스 쓰기는 0이다.
- 새 exact manifest에 대한 사용자 승인 질문을 보냈다. 응답 전에는 grant/launch하지 않으며 과거 `16433fff…` 및 감시 `5f90a58b…`의 승인 질문이나 ack를 이 범위로 이월하지 않는다. 두 공고의 현재 회사 정보만으로 추천 가능 확정이 되지 않는다는 원문 기반 기대 판정도 유지한다.
- 저장 회귀에 Drizzle 프로필 row codec 왕복을 더해 모름 상태의 메타 행을 다시 decode해도 size 값이 되살아나지 않음을 확인했다. 직접 `applyCompanyProfileAnswer.test.ts`와 웹 typecheck PASS. 이는 **격리 codec 검증**이며 운영 DB `match_state` 갱신이나 실제 브라우저 조작을 대신하지 않는다. 테스트 파일만 바뀌어 위 exact 모델 실행 계약 SHA에는 영향이 없다.
- PR #18의 최신 `680425e` Vercel·Preview Comments 검사도 PASS다. Preview 배포 완료는 로그인 후 아스카웍스 화면의 브라우저 UAT 또는 운영 배포 인수가 아니다.

## 2026-09-28 격리 PostgreSQL에서 사용자 답변 재진입 검증

- 사용자 답변은 `applyCompanyProfileAnswer → saveCompanyProfile(userId) → owned read`의 개인 범위이며, `refreshProfileQuestionMatchStates`는 `stateScope=user`일 때 공용 `match_state` 저장을 명시적으로 건너뛴다. 따라서 사용자 답변의 필수 영속 증거는 **개인 프로필 row와 재진입 후 다시 계산한 추천**이다. 앞 절에서 공용 `match_state` 미검증을 이 경로의 누락처럼 읽지 않는다.
- 전용 Unix socket PostgreSQL의 기존 product gate에 중소기업 필수 criterion 1건을 넣어 미입력 추천0 → 자가신고 저장·재조회 추천1 → 모름 저장·재조회 추천0, 최종 size null 및 unknown 상태를 검증했다. 같은 DB의 회사 소유권·RLS와 row codec을 통과한 결과다. 실제 아스카웍스 계정에 값을 쓰지 않았고, 이 fixture의 1건은 실공고 지원 자격 증명이 아니다.
- 첫 전체 gate는 별도 질문 준비 fixture의 첨부 archive에 `storage_key`가 없어 `attachments_missing`으로 실패했다. 최근 원문 아카이브 판정은 SHA와 저장 키를 모두 요구한다. 질문 준비·신규 정식 공급·source rebind의 세 **격리 fixture**에 해당 키를 명시하고 선언 첨부 행 1건 결속을 확인했다. 이후 `pnpm test:product-postgres` PASS: migration 93개, RLS, 개인 답변 재진입, 질문 발행/답변/철회와 `match_state`, 신규 공급 발행, source rebind까지 확인했다. 로그의 synthetic refresh outage는 실패 복구를 검증하는 의도된 경로이며 전체 종료 코드 0이다. 운영 원문·R2가 실제 저장됐다는 뜻은 아니다.
- 이 턴의 변경은 PostgreSQL 통합 테스트와 진행 기록에 한정된다. core package runtime·validator·prompt는 바뀌지 않아 `84bf20ea…` manifest의 모델 실행 계약은 유지된다. exact 승인 응답 전 grant/launch, 운영 쓰기는 없다.

## 2026-09-28 인증된 HTTP 프로필 답변 수용 검사

- 일회성 `tools/run-local-product-uat.mjs`에 회사 A의 `GET /api/web/company-matching → POST /api/web/profile/field(size=중소기업) → GET → POST(unknown) → GET` 수용 검사를 추가했다. 회사 소유자 인증 세션에서 버전 토큰을 이어 사용하고, 알려진 규모의 저장·재조회와 철회 후 unknown 상태·규모 미표시를 검증한다. 앞선 확인 질문 시나리오가 원래 소유자 세션을 종료하므로 이 검사는 별도 정상 로그인 세션을 연다. 첫 시도는 종료된 세션 재사용으로 401이었고, 이 수정 후 동일한 전체 UAT를 처음부터 다시 실행했다.
- 두 번째 격리 UAT PASS. 영수증 `/private/var/folders/90/3_v527vj59d6wv2ql7_k6rzm0000gn/T/cunote-product-uat-pg-s9Gvni/receipt.json`의 `profileAnswerAcceptance={status:passed,scope:isolated_authenticated_http_db,knownThenUnknown:true}`, source manifest SHA `ee75fb05f8e9ff7eb188c23977a2a0056f5ed12847e5aeee916afd8c782d1ab1`; packages/web/admin build와 계정 인증·회사 격리·확인 질문 시나리오 PASS. UAT는 새 Unix socket DB와 합성 공고를 사용했고 비밀번호는 로그/진행 문서에 기록하지 않았다. 실제 브라우저 버튼 조작, 운영 계정, 운영 R2/모델, 실제 아스카웍스 규모 판정은 이 영수증의 범위 밖이다.
- `tools/run-local-product-uat.mjs`만 실행 경로로 수정했으므로 분석 모델 계약과 현재 `84bf20ea…` 준비물의 runtime SHA는 바뀌지 않는다.

## 2026-09-28 ICT 파트너십 규모 조건 원문 재대조

- 감시 `b9ca511f…`는 이미 기록·ack된 과거 v26 `5f90a58b…`의 준비 알림이다. 이번 재확인에서도 현행 파일럿은 별도 v27 `84bf20ea…`이며, 이전 감시 알림을 grant·launch 승인으로 이월하지 않는다.
- BizInfo `PBLN_000000000126531`의 봉인 입력(`651f0e8f…`)을 다시 읽었다. 같은 입력 안에서 구조화 `trgetNm`은 `중소기업`, `bsnsSumryCn`은 `중소ㆍ중견기업`, 모집공고 첨부는 `ICT, AI 분야 중소 · 중견 기업`이라고 명시한다. 보관 NIPA 모집공고 PDF의 bytes SHA `f18bd693…`는 현재 첨부 SHA와 일치한다. [기업마당 상세](https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126531)의 공개 본문도 중소·중견을 표시한다. 독립 검수 sequence 54가 `size` criterion index 0을 `unsure`로 둔 직접 이유는 이 구조화 필드와 첨부의 범위 차이다.
- 상세 본문이 두 기관에서 일치한다는 사실은 의미 판정의 단서지만, 기존 출처 계약은 공식 구조화 대상과 상세 자격의 명시적 차이를 임의 선택해 해소하지 않는다. 이 건의 `source_review/condition_review`와 독립 검수 `unresolved`를 유지한다. `중견기업`을 자동 확정하거나 아스카웍스 추천 1건으로 계산하지 않는다. 현재 회사 규모도 비어 있다. 공식 범위의 별도 확인과 그 결과에 결속된 후속 검수·release가 필요하다. 이번 대조는 기존 immutable run/aggregate, 서비스 DB/R2, 모델 실행을 변경하지 않았다.

## 2026-09-28 운영 공급 재측정과 기존 분석 재사용 우선순위

- 제품과 같은 discovery 플래그로 아스카웍스 저장 프로필·현행 공고를 운영 DB에서 읽기 전용 재평가했다(2026-09-28T05:37:07Z). universe 1,502건 중 KST 당일 모집 중인 것은 529건이며 `verified` 22·`discovery` 507건이다. 검증 근거 22건의 실제 답변 판정은 추천 가능 0·조건부 14·탈락 8, `needs_profile_input` 1·`needs_core_review` 18·`oneAnswer` 1·`oneQuestionAway` 0이다. 추가 회사 질문만으로 검수 대기 18건을 해결할 수 없음을 다시 확인했다. 이는 모델 품질이나 실제 지원 가능량의 전수 판정은 아니다.
- 봉인된 classification `367b768b…`의 `review_current_conditions` 221건을 제목 키워드로만 좁혀 읽기 전용 shortlist를 만들었다(`spike-out/asca-test-20260927/current-review-shortlist-20260928.json`, bytes SHA `c5c3dcadbd35f2ac7009d90124605627ad4f34bc1270819a279687174e27fd94`). 제목만으로 소프트웨어 기업 자격을 인정하지 않는다. 48건은 관련성 조사 후보이고, 그중 과거 primary 이력은 23건이다. 종료일 필터는 저장 마감일에만 적용했으며 현재 status·신청 시작·원문 품질을 증명하지 않는다.
- 우선 검토한 K-Startup `179232`(공공데이터 오픈이노베이션), `179255`(스타트업 언론 홍보), `179294`(실리콘밸리 GTM)는 모두 과거 `publishable` run이 있으나 독립 검수에서 각각 target_type 누락, 제출 소재를 필수 자격으로 오인, 국외·플립기업의 창업기업 요건 누락이 지적됐다. 2026-09-28 현행 `prepareLabAnalysis` 재조회에서 세 건 모두 과거 input SHA와 달랐고, 첨부 SHA는 앞의 두 건만 같았다. 따라서 세 건은 과거 run의 단순 release/repair 재사용 대상이 아니다. 세 공고를 아스카웍스 지원 가능 건수에 더하지 않는다. 새 입력 결속·조건 의미 검수의 우선 후보로만 보존한다. 모델 호출·서비스 쓰기는 0이다.

## 2026-09-28 독립 검수 PASS 이력의 현행 재사용 결속 감사

- 위 제목 shortlist의 과거 primary 23건을 원본 launch receipt→독립 검수 manifest→aggregate의 각 bytes SHA와 exact sequence에 결속해 다시 열었다. 독립 검수에서 defect/unresolved가 없는 leaf는 6건이었다. 정식 `loadAnalysisLaunchPromotionCohort`로 각 leaf를 현행 release readiness까지 재검증한 결과 **6건 전부 `launch matching projection exact binding` 거부**로 안전 발행 대상 0건이다. 결과 파일 `spike-out/asca-test-20260927/reviewed-reuse-shortlist-20260928.json` bytes SHA `915120da628c618be41ac67ae01cab2ed8132b8ffae8c0644f3339ab6e6fee33`이다. 이는 제목 shortlist 23건의 현행 검사일 뿐 전체 221건의 PASS 부재 증명은 아니다.
- 같은 6건의 현행 `prepareLabAnalysis` input/attachment SHA를 읽기 전용 재조립했다(2026-09-28T05:50:31Z). 네 건은 input·attachment가 모두 변경됐고, 두 건 `PBLN_000000000126590`(강원 수출전략)·`PBLN_000000000126490`(K-소비재 IP)은 두 SHA가 모두 과거와 같다. 결과 파일 `spike-out/asca-test-20260927/reviewed-reuse-material-20260928.json` bytes SHA `5a02329dbae6db67d390de59b19dcbef98738097556c14df4bbf34ab1a80333c`이다. 두 동일 material run의 옛 matching projection snapshot SHA는 receipt와 일치하지만 runtime이 v14라 현행 v17 검사에서 거부됐다. `126490`은 current reprojection 결과도 달랐다. 따라서 과거 v7 독립 검수의 PASS를 현행 projection 검수로 간주하지 않는다.
- 두 동일 material 공고도 아스카웍스의 즉시 추천 공급으로 계산하지 않는다. `126590`은 강원 소재 기업, `126490`은 수출 소비재 기업 및 해당국 지식재산권을 대상으로 한다. 새 primary 없이 검수를 이어가더라도 현행 projection에 대한 별도 독립 검수와 현재 source/release gate가 필요하다. 이번 감사에서 모델 호출·서비스 쓰기·기존 불변 산출물 수정은 없었다.

## 2026-09-28 역사 primary의 현행 projection 신규 검수 경로

- 과거 run에 matching projection snapshot이 존재하면 독립 검수 packet 준비가 현행 runtime 불일치에서 즉시 거부되는 문제를 확인했다. 역사 snapshot의 source/output/report 무결성과 launch receipt 결속이 정확하고 차이가 runtime 재투영에 한정될 때, 현행 projection을 새 `derived_current` packet에 봉인하는 경로를 추가했다. 새 검수가 통과하면 release reader는 같은 현행 snapshot SHA를 다시 계산해 packet과 대조한다. 옛 `run_snapshot` packet의 PASS는 기존처럼 현행 projection으로 자동 승계되지 않고, 신규 경로의 `carryforward`는 `null`이다. 현재 input·attachment와 release 조건의 현행 검사는 별도 그대로 적용된다.
- 봉인 receipt `d98501f3…`의 동일 material 두 run `PBLN_000000000126590`·`PBLN_000000000126490`을 **읽기 전용** probe로 확인했다. 두 run artifact bytes SHA가 receipt와 일치하고 새 packet projection provenance는 `derived_current`, SHA는 각각 `9cb5ac37…`·`878747b1…`, release reader 재계산 결속은 일치, carryforward는 `null`이다. probe는 `spike-out/asca-test-20260927/probe-historical-current-review.ts`에 있다. 실제 독립 검수 모델 호출·aggregate·release·서비스 쓰기는 수행하지 않았으므로 품질/추천 가능 판정이 아니다.
- 회귀는 오래된 v14 ruleset snapshot을 현행 v17로 새 검수하는 경로, 과거 packet PASS 승계 거부, receipt 누락·grant 불일치·SHA 불일치·원천 criterion 결속 손상 차단을 확인한다. `matching-projection-review-carryforward.test.ts`, `independent-review-packet.test.ts`, `pnpm lab:release:test`, 웹 typecheck, `git diff --check` PASS. 독립 검수 packet 테스트의 기존 14,500자 상한과 폐기된 산업 규칙 문구는 2026-09-24 규칙 변경 후 낡아 있었고, 실제 공통 prompt 14,989자를 수용하는 15,000자 상한과 현행 자격 문구로 갱신했다. prompt 본문·validator·package runtime 코드는 변경하지 않았다.
- 위 두 실공고는 현행 matching projection에 대한 **새 독립 검수 결과가 없다**. 준비만 된 `84bf20ea…` 2건 manifest는 별도 live 승인 대기이며 grant/receipt/status가 없다. 이번 로컬 코드 변경을 새 모델 실행 승인이나 서비스 발행 승인으로 해석하지 않는다.

## 2026-09-28 재사용 4건과 초기창업 후보 원문 재대조

- 봉인 classification `367b768b…`의 reusable 4건을 운영 DB에서 읽기 전용 대조했다. 현재 바로 재사용 단계는 인도 BTS `PBLN_000000000126455` 한 건뿐이며 아스카웍스의 미확인 회사 규모 때문에 확정 추천이 아니다. 나머지 세 건은 `await_approved_release`이고 각각 해양플랜트 대상 `120588`, 원문 판독 오류가 이미 확인된 KISA `122516`, 경기도 사회적경제 대상 `121787`이다. `await_approved_release`를 품질 PASS나 아스카웍스 추천으로 계산하지 않는다. 사용한 조회 코드는 로컬 `spike-out/asca-test-20260927/audit-reusable-four.ts`다.
- 미검수 shortlist에서 범용 창업기업 후보 5건의 현재 모델 입력을 읽기 전용 재조립했다. `179255`는 본문과 HWP가 들어온 3,086자 입력이며 7년 이내 예비·초기기업 대상이지만, 과거 독립 검수에서 제출 소재를 필수 자격으로 오인한 결함이 있고 현재 input SHA가 과거 run과 달라 재사용 불가다. `178990`은 2,813자·이미지 OCR/텍스트 첨부가 있으나 legacy run 계약 및 현재 input이 다르다. `179175`는 PDF 공고문 변환 누락, `179294`는 공고문 PDF와 DOCX 변환 누락이다. `179232`는 65,107자 공공데이터 협업 공고로 과제별 적합성과 대표·규모·업력 요건이 있어 제목만으로 지원 가능 판정 불가다. 입력 감사 파일 `spike-out/asca-test-20260927/asca-broad-candidates-source-20260928.json`의 SHA는 `331c0b37634ceab5f53219610852a6a0344ac37a5dee1423913f31328882fc63`이다. 이 shortlist는 507건 전수 검수나 새로운 live 대상 변경이 아니다.
- 제공된 아스카웍스 사업자등록증을 시각적으로 대조했을 때 현 기준 약 1개월 업력이다. 최신 `owned_read`는 **이미** `biz_age_months=1`의 user-scoped self-declared 값을 반환했다(2026-09-28T06:22:56Z). 이전 저장 artifact의 `null`은 현재 계정값이 아니므로 업력 누락을 추천 0건 원인으로 취급하지 않는다. discovery 활성화 상태의 현재 universe 1,502·verified 22에서 업력 1개월을 다시 넣는 비영속 시나리오도 판정을 바꾸지 않았다(추천 0·조건부 14·탈락 8). 서비스 프로필 쓰기·유료 조회는 없었다.
- 같은 UI의 일반 결함으로 개업 첫 달 `0년 0개월` 답변을 불허하던 검사를 수정했다. core와 저장 codec은 0개월을 이미 유효값으로 처리했다. `match-results/logic.test.ts`, 웹 typecheck PASS. 초기창업자 첫 달 입력만 허용하며 실제 계정의 1개월 값이나 현재 22건 추천 결과를 바꾸지 않는다. 실제 브라우저 UAT는 로컬 개발 서버가 없어 미실행이다.
- exact19 감시 인계 `b9ca511f…`의 별도 준비 manifest `5f90a58b…`는 파일 bytes SHA 일치, `current-matching-campaign-20260928`의 `matching_only` 2건이다. 앞선 `160e9d6f…`와 target grantId 두 개는 같지만 package runtime SHA가 다르며, 현재 관측 state는 더 나중의 `84bf20ea…` manifest가 prepared이고 grant/receipt/status는 모두 null이다. 감시 state에서 `b9ca511f…`는 이미 ack 목록에 있다. 이 기록은 2건 실행·품질 승인·exact19 합산 근거가 아니다.

## 2026-09-28 현재 재고 PDF 입력 복구 경로

- K-Startup `179175`와 `179294`는 모두 PDF 공고문 원본이 보관·SHA 결속돼 있지만, 일반 아카이브는 PDF를 `skipped`로 두고 변환 서버 산출물이 없어 분석 입력에서 공고문이 `unavailable/markdown_missing`이었다. 전자는 2쪽 텍스트층 1,912자, 후자는 11쪽 16,172자를 원본 PDF SHA 검증 뒤 읽기 전용으로 추출했다. `179294`의 DOCX 신청서도 변환되지 않았지만 HWPX 신청서 텍스트는 입력에 있다. 현재 공고문의 자격 의미와 아스카웍스의 매출·제품·미국 진출 사실은 확정되지 않았다.
- 기존 `matching-pdf-source-recovery`의 v1은 대상이 이미 launch manifest에 있어야 해서 launch 입력 준비 이전의 PDF 누락 후보에 적용할 수 없었다. v1 계약을 보존하고, 현재 재고의 exact grant ID 1~10건에서만 v2 source-only 계획을 준비하는 `--prepare` 경로를 추가했다. `open/visible`·KST 신청기간, 현재 input/attachment SHA, PDF surface·보관 원본 SHA, 누락 파일 집합, 실제 R2 바이트를 모두 묶고 읽기 전용 `--plan`에서 다시 검증한다. 모델 실행이나 서비스 승격을 계획에 포함할 수 없으며 쓰기는 기존 별도 `--write`·receipt·확인값 경계에 남는다.
- 두 공고의 v2 계획은 `docs/evidence/2026-09-28-kstartup-179175-179294-pdf-source-recovery-plan.json`, 내부 plan SHA `fa3643a12cab5015e5fab59f8b21c1a8db34e4a4c89f67914c6c754eda6dd665`, 파일 bytes SHA `d2dbf5993065c9773b4612a56f18e3195cfef03d648e34e42c2ed19864e65203`다. 준비 2/2 PDF bytes 검증 및 이 버전 파일의 읽기 전용 preflight `READY_FOR_SOURCE_RECOVERY_APPROVAL` 2/2 PASS. 이 계획의 운영 R2/DB source-only 쓰기는 exact 범위 승인 전이라 실행하지 않았고 receipt도 없다. 원문 복구 후 새 input SHA로 모델 분석·독립 검수·release가 별도로 필요하다.
- `lab:matching-pdf-source-recovery:test` 3/3, `pnpm --filter web typecheck`, `git diff --check` PASS. 실제 v2 두 공고의 DB/R2 결속 preflight도 PASS했다. PDF 텍스트 문자 수는 문서 의미 판정이나 최종 추천 품질의 대체 증거가 아니다.
