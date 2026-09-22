-- 현재 raw hash에 결속된 소비 기능별 변경 영향 영수증을 보존한다.
-- 기존 이벤트는 이전 payload projection을 복원할 수 없으므로 NULL로 두고 보수적으로 검토한다.
ALTER TABLE "grant_collection_events" ADD COLUMN "change_impact" jsonb;
