# Screenshot Capture Blocker

인앱 브라우저와 Chrome 확장 브라우저 대상이 현재 세션에서 모두 비어 있어 스크린샷을 저장하지 못했다.

- `agent.browsers.get("iab")`: unavailable
- `agent.browsers.list()`: `[]`
- `agent.browsers.get("extension")`: unavailable
- `agent.browsers.list()`: `[]`

Product Design audit 지침상 Playwright fallback은 사용자 확인 후 진행해야 한다. 확인을 받으면 이 폴더에 다음 파일을 추가한다.

- `01-landing-start.png`
- `02-invalid-bizno-error.png`
- `03-teaser-loading.png`
- `04-teaser-result.png`
- `05-dashboard-transition.png`
- `06-dashboard-map.png`
