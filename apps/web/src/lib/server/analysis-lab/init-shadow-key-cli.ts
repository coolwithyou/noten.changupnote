import { join, relative } from "node:path";
import { ensureLocalArtifactHmacKey } from "./local-artifact-hmac-key";
import { findMonorepoRoot } from "./run-store";

async function main(): Promise<void> {
  const root = findMonorepoRoot();
  const envPath = join(root, "apps/web/.env.development.local");
  const result = await ensureLocalArtifactHmacKey(envPath);
  const label = result.status === "created" ? "새 전용 키를 생성했습니다" : "기존 전용 키가 유효합니다";
  console.log(`[lab:shadow-key] ${label}: ${relative(root, result.envPath)}`);
  console.log("[lab:shadow-key] 키 값은 출력하지 않았으며 파일 권한은 0600입니다.");
}

main().catch((error) => {
  console.error("[lab:shadow-key] 실패:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
