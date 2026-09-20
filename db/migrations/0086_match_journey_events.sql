-- 기존 로그인 회사별 매칭 이벤트에 개인정보 없는 행동 분류를 추가한다.
ALTER TABLE "match_events" ADD COLUMN "journey" jsonb;
