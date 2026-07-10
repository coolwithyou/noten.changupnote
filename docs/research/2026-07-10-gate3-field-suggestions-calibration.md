# Gate 3 사전 등재 항목 재대조 — Apply Experience v2 P4(생성형 필드 제안) 착수 전

- 수행: 2026-07-10, Apply Experience v2 오케스트레이션 메인 세션(감독자)
- 대상: CALIBRATION-TEMPLATE "Gate 3 착수 전" 등재 3항목 — fill strategy 5종(마스터 8.7) · evidence 정렬 validator(마스터 8.8) · 적합도 라벨 UX(마스터 9.9)
- 트리거: 설계 문서(2026-07-09-apply-experience-v2.md) 상단 blockquote + §8 Phase 4 주의 문구 + 핸드오버 §5-G1

## 외부 축 처리 (감독자 결정)

**신규 웹 조사 생략.** 직전 외부 대조가 하루 전(2026-07-09, 설계 §3 R1~R10 — 출처 §13)이며, 등재 3항목을 이미 직접 커버한다:

- fill strategy → R1(자율 폼필링 정확도 5% 미만 실측 → 확정 프로필 매핑 + 필드 단위 컨펌 게이트만 안전) — 마스터 8.7의 전략 분리(자동 vs 질문 vs 금지)와 같은 결론
- evidence 정렬 → R4(할루시네이션 법적 리스크, Citations API, 인용 강제 원칙 P4)
- 적합도 라벨 → R2(Google PAIR "신뢰도를 숫자로 표시하지 마라", HAX G9) — 마스터 9.9 라벨 정책과 동일 결론

1일 델타 재조사는 실익이 없어 생략한다(선례: 2026-07-04 대조에서 2일 델타 사유로 제품·규제 축 생략). 규제·경쟁 신호는 기존 결정대로 필드 테스트 전 대조에서 다룬다.

## 전제별 판정표 (내부 정합 — 마스터 전제 ↔ P4 계획 §7.4/ADR-8)

| 전제 | 판정 | 근거 |
|---|---|---|
| **8.7 fill strategy 5종** (copy/summarize/generate/ask_user/manual) | **보강** | 매핑 확인: copy→`source:"profile"` 시드(P2-7 구현 완료), summarize·generate→`source:"llm"`(P4, 두 전략은 v1에서 단일 LLM 트랙에 흡수 — 허용), ask_user→(b)상태 missingFields 질문 카드(P2b 구현 완료). **누락: manual(서명·직인·첨부·동의 — 자동 처리 금지).** P4 field-suggestions가 라벨 제한 없이 서명·동의류에도 제안을 생성할 수 있다 → **P4 규약 추가: manual류 라벨은 LLM 제안 생성·저장 금지(제외 목록 + 카드에서 '제안 받기' 미노출)** |
| **8.8 evidence 정렬 validator** (evidenceRefs 필수 + 값↔근거 span 정렬, post-rationalization 차단) | **보강** | §7.4의 "basis 없는 제안 미반환·미저장"은 존재 강제만 있고 **basis가 그라운딩 원문에 실재하는지 검증이 없다**(모델이 지어낸 근거 문자열 통과 가능). → **P4 규약 추가: basis 실재 검증** — 공고문 유래 basis는 그라운딩 markdown에서 실재 확인(정규화 부분 문자열 매칭, `ingest:knowledge`의 quote 실재 검증 선례 재사용), 불통과 시 해당 제안 폐기. 완전한 값↔근거 **span 정렬**(마스터 8.8 원형)은 FieldDraftResult 파이프라인 확장 시점으로 이월(v1 과잉) |
| **9.9 적합도 라벨 UX** (숫자 confidence 일반 사용자 미노출, 라벨만) | **유지** | 설계 §4.3 "신뢰도 숫자 표시 금지"가 레드팀 검증 규약으로 명문화됐고 P2b FieldCard가 이미 집행(검수 D에서 확인). P4 라벨 "제안 — 확인 필요" 준수 설계 |

## 반영

- 판정 2건(보강)을 설계 문서 §7.4에 추기(v2.4) 후 P4 위임 프롬프트의 "임의 변경 금지 규약"에 포함한다.
- 측정 전 채택 금지 원칙 준수: 새 도구·모델 도입 없음(기존 `CHAT_DRAFT_MODEL` 라우팅 유지).
- CALIBRATION-TEMPLATE 이력에 본 문서 등재.
