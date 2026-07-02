/**
 * 필드맵 라벨 JSON 을 golden_set(kind=field_map) 으로 승격(upsert)하는 공용 로직.
 *
 * 파일 파이프라인(load-golden-field-maps.ts)과 리뷰어 워크스페이스 확정 경로가
 * 동일한 순환성 가드 + upsert 규약을 쓰도록 한 곳으로 모은다.
 *
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md
 */
import { and, eq } from "drizzle-orm";
import type { CunoteDbSession } from "./client";
import * as schema from "./schema";
import { evaluateReviewer } from "./field-map-review-guard";

export const DEFAULT_FIELD_MAP_GOLDEN_VER = "field_map_v0";

export type PromoteResult =
  | { ok: false; reason: string }
  | { ok: true; action: "insert" | "update"; reviewer: string; curatedBy: string | null };

/**
 * 이메일 → users.id 조회. 없으면 null (golden_set.curatedBy 는 nullable).
 */
export async function resolveUserIdByEmail(
  db: Pick<CunoteDbSession, "select">,
  email: string | null | undefined,
): Promise<string | null> {
  if (!email) return null;
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * 라벨 JSON 을 golden_set 으로 승격한다.
 * - 순환성 가드(evaluateReviewer)를 통과해야만 적재한다.
 * - gold 는 라벨 JSON 전체(docRef/labeledBy/labeledAt/pageCount/fields).
 * - 멱등: 같은 (kind, ref, goldenVer) 가 있으면 gold/curatedBy 갱신, 없으면 삽입.
 */
export async function promoteFieldMapGolden(
  db: Pick<CunoteDbSession, "select" | "insert" | "update">,
  params: {
    docRef: string;
    gold: Record<string, unknown>;
    labeledBy: string | null | undefined;
    reviewedBy?: string | null | undefined;
    goldenVer?: string;
    write?: boolean;
  },
): Promise<PromoteResult> {
  const gate = evaluateReviewer(params.labeledBy, params.reviewedBy);
  if (!gate.ok) return gate;

  const goldenVer = params.goldenVer ?? DEFAULT_FIELD_MAP_GOLDEN_VER;
  const curatedBy = await resolveUserIdByEmail(db, gate.reviewer);

  const existing = await db
    .select({ id: schema.goldenSet.id })
    .from(schema.goldenSet)
    .where(
      and(
        eq(schema.goldenSet.kind, "field_map"),
        eq(schema.goldenSet.ref, params.docRef),
        eq(schema.goldenSet.goldenVer, goldenVer),
      ),
    )
    .limit(1);
  const existingRow = existing[0];
  const exists = existingRow !== undefined;

  if (params.write !== false) {
    if (existingRow) {
      await db
        .update(schema.goldenSet)
        .set({ gold: params.gold, curatedBy })
        .where(eq(schema.goldenSet.id, existingRow.id));
    } else {
      await db.insert(schema.goldenSet).values({
        kind: "field_map",
        ref: params.docRef,
        gold: params.gold,
        goldenVer,
        curatedBy,
      });
    }
  }

  return { ok: true, action: exists ? "update" : "insert", reviewer: gate.reviewer, curatedBy };
}
