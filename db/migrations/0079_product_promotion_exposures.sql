CREATE TABLE "product_promotion_exposures" (
	"promotion_item_id" uuid PRIMARY KEY NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_promotion_exposures" ADD CONSTRAINT "product_promotion_exposures_promotion_item_id_analysis_lab_promotion_items_id_fk" FOREIGN KEY ("promotion_item_id") REFERENCES "public"."analysis_lab_promotion_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_promotion_exposures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_promotion_exposures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 클라이언트 SQL 권한 없음. 서명과 로그인 회사 문맥을 검증한 서버만 기록한다.
CREATE FUNCTION "app_private"."protect_product_exposure_receipt"() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'product exposure receipts are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "product_exposure_append_only" BEFORE UPDATE OR DELETE ON "product_promotion_exposures"
FOR EACH ROW EXECUTE FUNCTION "app_private"."protect_product_exposure_receipt"();
