// 읽기 전용: DB mutation, 모델 호출, 질문 draft/발행, deployment를 수행하지 않는다.
import { loadReadOnlyGrantReadinessReport } from "./grantReadinessLoader";

const args = process.argv.slice(2);
const limit = readPositiveInteger("--limit", 20_000);
const sampleLimit = readPositiveInteger("--sample-limit", 10);
if (args.some((arg) => !arg.startsWith("--limit=") && !arg.startsWith("--sample-limit="))) {
  throw new Error("사용법: tsx grantReadinessReport-cli.ts [--limit=20000] [--sample-limit=10]");
}

const report = await loadReadOnlyGrantReadinessReport({ limit, sampleLimit });
console.log(JSON.stringify(report, null, 2));

function readPositiveInteger(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const values = args.filter((arg) => arg.startsWith(prefix));
  if (values.length === 0) return fallback;
  if (values.length !== 1) throw new Error(`${name}은 한 번만 지정할 수 있습니다.`);
  const parsed = Number(values[0]!.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return parsed;
}
