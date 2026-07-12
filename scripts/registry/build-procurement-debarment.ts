/**
 * 조달청 부정당업자(참가자격 제한) 배치 적재기 — data.go.kr 15137996 CSV → registry_index.
 *
 * registry 는 라이브 API 가 아니라 오프라인 배치로 적재한 registry_index 를 조회하는 소싱이다.
 * 이 스크립트가 그 적재 계층: CSV 를 파싱해 소스 전량 재적재(replaceBySource)한다.
 *
 * 실행:
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     scripts/registry/build-procurement-debarment.ts --file <path.csv> [--dry-run]
 *
 * CSV 인코딩: data.go.kr 파일데이터는 보통 EUC-KR/CP949 다. Node 는 CP949 를 기본 디코드
 *   못 하므로 사전 변환이 필요하다:  iconv -f EUC-KR -t UTF-8 원본.csv > utf8.csv
 *   어댑터는 "디코딩된 문자열"을 받는 순수 함수라 인코딩은 이 경계 밖에서 처리한다.
 *
 * --dry-run: 파싱 결과만 리포트(DB 미접촉). 실적재는 --file 만 주면 replaceBySource 실행.
 *   실적재는 DATABASE_URL(.env.local)과 CUNOTE_REPOSITORY_ADAPTER=drizzle 전제.
 */
import { readFileSync } from "node:fs";
import { loadMonorepoEnv } from "../../apps/web/src/lib/server/loadMonorepoEnv";
import {
  PROCUREMENT_DEBARMENT_SOURCE,
  parseProcurementDebarmentCsv,
} from "../../packages/core/src/registry/adapters/procurement-debarment.js";

loadMonorepoEnv();

interface Args {
  file: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let file: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      file = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { file, dryRun };
}

async function main(): Promise<void> {
  const { file, dryRun } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("사용법: --file <csv 경로> [--dry-run]");
    process.exit(1);
    return;
  }

  const csv = readFileSync(file, "utf8");
  const records = parseProcurementDebarmentCsv(csv, { fetchedAt: new Date() });
  const withBizNo = records.filter((r) => r.bizNo !== null).length;
  const active = records.filter((r) => r.validUntil === null || r.validUntil.getTime() >= Date.now()).length;

  console.log(`파싱 완료: ${records.length}행 (사업자번호 보유 ${withBizNo} · 활성 ${active})`);
  const sample = records[0];
  if (sample) {
    console.log(
      `샘플: ${sample.nameNormalized} · bizNo=${sample.bizNo ?? "-"} · ~${
        sample.validUntil ? sample.validUntil.toISOString().slice(0, 10) : "무기한"
      }`,
    );
  }

  if (dryRun) {
    console.log("dry-run — DB 미접촉. 실적재는 --dry-run 없이 재실행.");
    return;
  }

  // 실적재 — DB 접근은 이 분기에서만 동적 import(dry-run 을 import 경량으로 유지).
  const { getCunoteDb } = await import("../../apps/web/src/lib/server/db/client");
  const { createDrizzleRepositories } = await import(
    "../../apps/web/src/lib/server/repositories/drizzle"
  );
  const repositories = createDrizzleRepositories({ dialect: "drizzle", client: getCunoteDb() });
  const inserted = await repositories.registryIndex.replaceBySource(
    PROCUREMENT_DEBARMENT_SOURCE,
    records,
  );
  console.log(`적재 완료: ${inserted}행 (source=${PROCUREMENT_DEBARMENT_SOURCE}, 전량 재적재)`);
  process.exit(0);
}

void main();
