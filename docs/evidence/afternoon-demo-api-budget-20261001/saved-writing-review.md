# 저장 문안과 서술형 양식 비교·반영

2026-10-01. 실제 원본의 기업 소개는 unique table_cell_region이며 beforeText 0자, 복원 서식·문자·인접 문맥 해시가 확인됐다. 기존 저장 문안 admission은 table_cell_text만 허용해 안전한 빈 서술형 region도 비교하지 못했다. 같은 engine은 region 수집/반영/복구를 이미 지원한다.

빈칸·기존에 인정된 안내문은 text/region 모두 비교·반영할 수 있도록 target 종류를 맞췄다. 일반 기존 내용은 기본 admission과 일반/자동 프로필 입력에서 계속 거부한다. 새 저장 문안 전용 검토 경로는 다음 순서로만 기존 내용을 교체한다.

1. long_text 문항 하나와 unique 지원 target을 확인해 현재 내용과 저장 문안을 함께 표시한다.
2. 빈칸·기존 인정 안내문이 아니면 기본 미선택 체크박스 ‘현재 내용을 검토했으며 저장 문안으로 바꾸겠습니다’를 선택해야 반영 버튼이 활성화된다.
3. 반영 때 최신 저장 문안 revision+text+권한, 현재 native beforeText 및 교체 확인 필요 여부를 다시 확인한다. 비교/문항 전환/문안 편집은 확인을 초기화한다.
4. surface는 narrative review를 같은 long_text fieldId 하나에만 허용하고 automatic과 혼합하지 않는다. transaction에서 native evidence.text와 exact expectedBeforeText를 재대조한다. 명시 검토 preimage가 동일할 때만 기존 내용 보호를 통과한다.
5. 기존 document/format/adjacent preimage 검증, 서버 snapshot revision CAS, 불확실 mutation 잠금과 역순 복구를 그대로 사용한다.

4,000자 초과·빈 저장 문안·지원하지 않는 target·ambiguous/missing/resolving 위치는 계속 차단된다. `(향후 1년 이내)` 같은 기간 문구를 일반 안내문으로 인정하는 regex 확장은 하지 않는다. 명시 검토 경로에서만 사람이 현재 문구를 확인하고 교체한다.

검증 PASS: writingFieldApplication 기본 보호/명시 admission/미선택 거부/저장 revision·text·권한 변경/현재 원본 변경; profile transaction의 일반 overwrite 차단·미확인 차단·stale preimage 차단·검토 text 성공 및 복구; region transaction의 같은 차단·복수 문단 반영·인접 셀 보존·원문/서식 복구; WorkspaceView render; 웹 typecheck. 이 검증에서 모델/API/운영 쓰기/브라우저 변경은 0회다. 최종 combined build와 운영 UI 확인은 담당자가 수행한다.
