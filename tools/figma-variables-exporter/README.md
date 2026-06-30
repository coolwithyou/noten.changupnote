# TDS Variables Exporter

Figma REST API에서 `file_variables:read` scope를 받을 수 없을 때 쓰는 로컬 개발 플러그인입니다. TDS Figma 파일을 연 상태에서 실행하면 현재 파일의 Local Variables와 Local Styles를 JSON으로 내보냅니다.

## 사용 방법

1. Figma에서 TDS 파일을 엽니다.
2. 상단 메뉴에서 `Plugins > Development > Import plugin from manifest...`를 선택합니다.
3. 이 파일을 선택합니다:

   ```text
   tools/figma-variables-exporter/manifest.json
   ```

4. `Plugins > Development > TDS Variables Exporter`를 실행합니다.
5. 플러그인 창에서 `Copy` 또는 `Download`를 사용해 JSON을 저장합니다.
6. 저장한 JSON을 프로젝트에 전달하면 `DESIGN.md`와 shadcn/TDS 매핑에 반영할 수 있습니다.

Figma가 `The manifest editorType does not include "dev"` 오류를 표시하는 경우 Dev Mode 컨텍스트에서 가져오기를 시도한 것입니다. 이 플러그인은 `editorType`에 `figma`와 `dev`를 모두 포함합니다.

## 포함 데이터

- Local variable collections
- Local variables
- Local paint styles
- Local text styles
- Local effect styles
- Local grid styles
- 선택 시 team library variable 목록

## 주의

- 이 플러그인은 네트워크 요청을 하지 않습니다.
- 토큰이나 비밀값을 포함하지 않습니다.
- 파일이 외부 라이브러리 변수만 참조하고 local variables가 비어 있다면 `Team library variables도 조회` 옵션을 켜서 변수 이름과 타입 목록을 보조로 확인하세요.
