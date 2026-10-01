# 2026-10-01 오후 종합 시연 시나리오

## 현재 시연과 완료 경계

주 시나리오는 **싱가포르 현지 진출 지원 국내 블록체인 기업 모집 재공고**다. 일반 사용자 계정과 일반 회사 프로필로 공고 조건을 확인하고, 실제 HWPX 신청서에 등록정보를 채운 뒤 사업 설명·회사 자료를 근거로 문항별 문안을 작성한다. 문안 저장, 원본 반영, 서버 저장, 다운로드, 다시 열기를 각각 확인한다.

정상 시연 흐름을 실제 인수했다. 공고 조건 7/7, 초기 RHWP 7쪽, 회사명 seed 1개와 등록정보 UI 입력 17개, 사업 설명 8항목·자료 1개, 상담 2턴을 확인했다. 문항 AI 결과를 사람이 검토한 소개 343자와 사업계획 962자를 revision 2로 저장하고, 원본의 해당 셀에 정상 반영했다. 최종 서버 저장·다운로드·독립 native 재열기·신청 관리에서 같은 draft 복귀가 모두 PASS이며 최종 RHWP는 8쪽이다. **66개 문항 전체 작성이나 공식 제출 완료를 뜻하지 않는다.** 자동 결속에서 제외한 14개 제한은 유지한다.

최종 인수 제품 소스는 `582792f70d7d72bc9549b9b9b0cf37eefdd6f1c8`, 운영 배포는 `dpl_2rrpgF3iwdZqRGQMmpqikkDRfgeF` READY다. 최초 정상 승격 `d745bfc` 이후 native 결속 안전, 근거 범위의 단위 정규화, 서술형 현재내용의 명시 교체 검토를 일반 경로로 개선했다. [배포 증거](../evidence/web-deployment-20261001.md)를 따른다. 상세 실행 상태는 [진행 기록](../../PROGRESS-demo-account-20261001.md)이 정본이다.

## 정확한 대상

| 항목 | 대상 |
| --- | --- |
| 일반 회사 | `a0132dd3-9cb7-87a1-95ef-6cfc171a795f` |
| 공고 | 싱가포르 현지 진출 지원 국내 블록체인 기업 모집 재공고 |
| grantId | `9837fd9b-0b15-4e70-b1b5-0fe3765e980c` |
| 원천 | Bizinfo `PBLN_000000000126841` |
| 신청기간 | 2026-09-28 ~ 2026-10-08 14:00 |
| 작성 중 draft | `efc28b23-5fe5-46ab-9a59-51c485ed318f` |
| 원본 | `[신청서식] 싱가포르 현지 진출 지원 국내 블록체인 기업 모집 재공고.hwpx` |
| 원본 크기·SHA | 127513 bytes / `ceb2c53a1a4ff825e3661deecd5a7533d23a4d55f2e82126a240b6de3f06e150` |
| 신청서 분석 | `roundtrip-2026-10-01T050056.268Z-98c796`, 추천 66개, coverage complete |
| 운영 연결 | 정상 exact 1건 release/promotion/verify PASS, 초기 7쪽 → 최종 재열기 8쪽 |

로그인·비밀번호·전화·이메일 등 인증 정보와 개인 연락처는 이 문서에 보관하지 않는다. 회사와 사업 구상은 합성 시연 값이며 공식 조회·실적 증빙으로 표시하지 않는다.

정상 release는 `deep-afternoon-demo-20261001-r1-20261001T055109Z-d745bfcd`이며 prepare → aggregate → shadow → dry-run → actor 분리 approve → promote → verify가 모두 성공했다. manifest SHA는 `f2b25ec31e434f8b53b9945114d380907a98bc83c776434878c98f8586e93fff`다. [운영 릴리스 영수증](../evidence/demo-account-20261001/operational-release/manifest.json)을 근거로 하며 로컬 부분 검증을 운영 승격 증거로 사용하지 않는다.

## 회사와 사업 설명

일반 회사 프로필에는 경기 소재 소프트웨어 중소법인, 업력 24개월, 직원 5명, 연 매출 1억 2천만 원의 합성 설정을 사용했다. 블록체인 기반 B2B 공급망 문서 검증 SaaS로 싱가포르 시장을 검증하는 사업 구상이다. 원문 파일은 기업별 권한 저장소에 두고 해시·승인 이력을 공유 원장으로 대조한다. 공개 원장에 원문 전체나 개인정보를 저장하는 제품으로 설명하지 않는다.

현재 계약 고객·수출 실적·현지 파트너·MoU·특허·인증·검증된 성능은 없는 것으로 구분했다. 전시 고객 인터뷰와 시제품 시연, 후속 요구사항 반영·PoC 제안은 조건부 미래 계획이다. 현재 매출에서 2024/2025/2026 반기 실적을 역산하지 않는다. 출장 가능·영어 피칭·대표/C-level 참여 조건은 사용자 확인 항목이며 공식 인증 사실로 만들지 않는다.

사업 설명은 projectName, problem, solution, customers, differentiation, goals, budget, timeline의 8항목이다. 일반 UI에서 revision 2로 저장했고, 신청 전용 `user_statement` 자료 **시연용 합성 회사·제품 소개 (실제 기업 증빙 아님)** 1개를 추가·선택했다. 사업 설명 GET과 파일 head GET이 모두 200인 [서버 재조회 증거](../evidence/demo-live-20261001/brief-and-autofill-head-readback.json)를 확인했다.

자체 계획 예산 500만원과 공고의 약 250만원 이내 변동 가능한 체재비 지원을 구분한다. 지원액을 확정 수입으로 합산하거나 전시품 배송 등 미지원 비용을 지원 예산으로 분류하지 않는다.

## 시연 순서와 인수표

| 단계 | 화면에서 할 행동 | 현재 인수 상태와 증거 | 완료 조건 |
| --- | --- | --- | --- |
| 1. 내 회사·공고 선택 | 위 회사로 싱가포르 공고를 연다. | 확인: 회사 문맥과 실제 공고 연결. | 동일 companyId/grantId 유지. |
| 2. 조건 대조 | 회사 값·자가 신고·추가 답변과 원문 조건을 확인한다. | 확인: 실제 화면 7/7 조건 확인. [화면](../evidence/demo-live-20261001/matching-seven-confirmed.png). | 조건 확인을 선정·출장·공식 자격 보장으로 설명하지 않는다. |
| 3. 실제 신청서 열기 | 지정 HWPX 작성 화면에서 원본 7쪽을 확인한다. | 확인: 일반 persistent RHWP. [화면](../evidence/demo-live-20261001/rhwp-open.png). | 같은 draft/source, 원문과 작성 도우미가 함께 보인다. |
| 4. 등록정보 입력 | 회사명 seed와 일반 등록정보 dialog의 제안을 검토·적용한다. | 확인: seed 1 + UI 17, 서버 저장·다운로드 성공. [화면](../evidence/demo-live-20261001/autofill-seventeen.png), [셀 비교](../evidence/native-binding-safety-20261001/report.json). | 지원하지 않는 프로필 의미·기존 값·위치 미확인 칸은 자동 반영하지 않는다. |
| 5. 사업 설명·자료 저장 | 8항목과 합성 소개 자료를 신청 문맥에 연결한다. | 확인: revision 2, 선택 자료 1개, GET 200. [재조회](../evidence/demo-live-20261001/brief-and-autofill-head-readback.json). | 문항 생성이 같은 저장 문맥과 자료를 사용한다. |
| 6. AI 상담 | 시장 검증·예산·공고 요구를 일반 상담에서 확인한다. | 확인: 2턴 서버 이력. 지원액 표현은 후속 질문으로 정정했다. [이력](../evidence/demo-live-20261001/consultation-messages.json), [화면](../evidence/demo-live-20261001/ai-consultation.png). | 답변 내용과 이력 보존을 구분하고 확정되지 않은 사실을 만들지 않는다. |
| 7. 문항 AI 생성·검토 | 위치가 검증된 소개·사업계획에서 실제 문안·근거를 검토한다. | 확인: 소개 section6·사업계획 section9 ready. 사람이 소개 2개 사실 문단·사업계획의 조건부 계획을 검토해 각각 revision 2, 343/962자로 저장. [소개 생성](../evidence/demo-live-20261001/section6-ready-readback.json), [계획 생성](../evidence/demo-live-20261001/section9-ready-readback.json), [저장본](../evidence/demo-live-20261001/final-saved-sections.json). | 실패·timeout 이력은 보존하며 성공 응답과 검토 저장을 분리한다. |
| 8. 문안 저장→원본 반영 | 현재 셀·저장 문안을 비교한 뒤 해당 셀에만 적용한다. | 확인: 소개 빈 region cell8, 계획 안내문 region cell14. 기존 내용 교체 checkbox 기본해제·적용 비활성을 확인하고 명시 체크 후 정상 적용. [native exact 검증](../evidence/demo-live-20261001/final-native-readonly-proof.json). | 현재 문안 revision·exact preimage·단일 target 보호. 일반 등록정보 기존값 보호는 유지. |
| 9. 최종 서버 저장·다운로드 | header에서 파일을 저장하고 HWPX를 내려받는다. | 확인: GET 200, revision `61cb04e7-9ef0-4d42-8f03-232e0a41e988`, 101211 bytes. 서버 head와 다운로드 SHA 동일, ZIP·XML 6개 parse PASS. [서버 증거](../evidence/demo-live-20261001/final-server-head-readback.json). | 등록정보 파일 대비 514셀 중 지정 2셀만 변경, 나머지 512셀·표 구조·비표 본문 보존. |
| 10. 재열기·신청 관리 복귀 | 일반 신청 관리의 문서 열기로 같은 draft를 연다. | 확인: 최종 RHWP 8쪽, 계획 textarea revision 2/962자와 native 비교 값 exact 동일. 재열기 후 다운로드도 같은 bytes/SHA. 교체 체크박스는 해제·적용 버튼 비활성으로 초기화. [운영 재열기](../evidence/demo-live-20261001/final-reopened-readback.json). | 독립 파일 재열기와 운영 UI 복귀를 각각 검증. |

위 10단계의 실제 인수 증거를 확보했다. [준비·완료 영수증](../evidence/demo-account-20261001/preparation-receipt.json)은 현재 싱가포르 인수와 한남 역사 기준선을 분리한다. 실패/timeout·수량 검증 오류를 성공으로 바꾸지 않았으며, 최종 성공은 정상 생성·검토·반영·저장·재열기의 증거로 판단했다.

최종 파일은 `창업노트-싱가포르-시연-20261001.hwpx`, SHA `a0cd52ea335711614ba0074d9aeae5fa1c567481571965fa906a4dfe098ab17e`다. 최초 최종 다운로드, 재열기 후 다운로드, 사용자 Downloads의 제공 파일은 bytes가 정확히 같다. native 전체 문단으로 읽은 소개/계획 343/962자는 서버 저장 문안과 exact 동일하다. IR 파서의 합친 셀 텍스트는 문단 줄바꿈 처리 때문에 342/959자로 보이지만, 실제 native 문단 비교는 차이 없이 통과했다.

API 예산은 승인 $20 안에서 reported 추정 $0.7996601 + 미확인 예약 $9.9825089 = $10.782169로 관리됐다. timeout $7과 상담 잔여 예약 $2.9825089는 유지하며, 공급자 청구서 대조는 미완료다. [예산 최종 상태](../evidence/afternoon-demo-api-budget-20261001/final-budget-status.json)를 따른다.

## Native 자동 반영의 별도 제한

분석 추천 66개와 실제 입력 위치 확인 수는 다르다. 기존 62/66 unique 결과를 읽기 대조했을 때 숫자 5개가 다른 연도·행으로 밀리는 일반 resolver 결함을 발견했다. 일반 수정 후 현재 **52 unique / 14 blocked(missing)**다. [수정·실증 기록](../research/2026-10-01-native-라벨-순번-입력결속-안전검증.md)을 따른다.

제외 항목은 단위만 적힌 숫자 값 셀 8개, 제목·중복 안내문 3개, `(향후 1년 이내)` 값 셀 2개, 원문 라벨 위치와 분석 좌표가 다른 투자유치 선택 1개다. 원문 occurrence는 전체 exact 라벨 셀에서 먼저 선택하고 source row/col을 대조한다. 단위·안내가 있는 값 셀 자체에 쓰려면 명시된 same-cell target 또는 보호 영역 계약이 필요하다. 이 계약이 없는 칸을 대체 좌표로 추정하거나 데모 예외로 열지 않는다.

등록정보 다운로드는 514개 IR 셀 중 입력 변경 18개(회사명 1, 주소 1, 성명 4, 이메일 4, 전화 8), 알려진 자간 공백 정규화 1개, 나머지 495개 보존을 확인했다. 모든 rowSpan/colSpan도 보존됐다. 사업자번호 기존 template, 홈페이지 주소, 영문 회사명, 법인등록번호 변경은 0이다. 이 증거는 입력 위치·보존 검증이며, 모든 프로필 값의 공식 원장 일치나 최종 제안서 완성을 의미하지 않는다.

## 별첨: 한남 역사 기준선

한남대학교 캠퍼스혁신파크 입점자 모집 공고 `b1d964ae-fe8b-4212-9fa7-31d65a4ded12`는 이번 세션 초기에 일반 계정의 직접 편집·서버 저장·다운로드·일반 상담 API를 검증한 역사 기준선이다. 원본 `(제출서류)임대신청서및사업계획서 (1).hwpx`는 126593 bytes, SHA `c60c644e7fe02d630843236ac9bcebc7aacaf08cb3c1428cd509f3a81bb2ce09`다.

역사 v8 필드 95개는 현행 자동 입력 결속의 완료 증거가 아니며, 호실 경로·제조시설 등 원문 검수 쟁점이 남았다. 기존 한남 draft와 입주용 사업 설명은 보존한다. 한남 직접 편집 성공을 싱가포르의 문항 AI·최종 제안서 인수로 합산하지 않는다.
