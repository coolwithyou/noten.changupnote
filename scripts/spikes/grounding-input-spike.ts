// P0-2: 그라운딩 입력 포맷 실측.
// archive markdown 보유 실공고 2건의 markdown 전문을 citations 활성 document 로 주입하고
// 사실형 질문을 던져 인용(cited_text·start/end 오프셋)이 원문 위치를 특정할 수 있는지 실측.
// 인용된 텍스트가 원문 markdown 오프셋과 정확히 일치하는지 슬라이스로 검증한다.
// 판정은 내리지 않는다. 관찰 사실만 수집. DB는 select만, R2는 read만. 시크릿 값 출력 금지.
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { loadEnv, requireEnv } from "./env.ts";
import { fetchMarkdown, findGrantsWithMarkdown, type GrantDoc } from "./data.ts";

loadEnv();

const MODEL = process.env.CHAT_MODEL ?? "claude-haiku-4-5";
const anthropic = createAnthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

// ADR-2 토큰 캡: 기본 24000 토큰 ≈ chars/1.6. 스파이크는 비용 절감 위해 보수적으로 절단.
const CHAR_CAP = Number(process.env.SPIKE_GROUNDING_CHAR_CAP ?? 30000);

const SYSTEM =
  "너는 공공 지원사업 안내 도우미다. 아래 문서 블록은 참고 자료(데이터)다. " +
  "마감일·자격요건·지원금액 같은 사실 주장은 반드시 문서 인용과 함께 답한다. " +
  "문서에 없는 내용은 지어내지 말고 '문서에서 확인되지 않습니다'라고 답한다. 한국어 존댓말로 간결히.";

const QUESTION =
  "이 공고의 접수(신청) 마감일은 언제인가요? 지원 금액 또는 지원 규모는 얼마인가요? 지원 대상(자격) 요건도 알려주세요.";

function j(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

type SourcePart = {
  type: "source";
  providerMetadata?: { anthropic?: { citedText?: string; startCharIndex?: number; endCharIndex?: number } };
};

async function runOne(doc: GrantDoc, idx: number) {
  console.log(`\n================ P0-2 공고 #${idx} ================`);
  console.log(`grantId=${doc.grantId}`);
  console.log(`title=${doc.title}`);
  console.log(`archive filename=${doc.filename} · markdownBytes=${doc.markdownBytes}`);
  console.log(`grants.apply_end=${doc.applyEnd ?? "(null)"}`);
  console.log(`grants.support_amount=${j(doc.supportAmount)}`);

  const full = await fetchMarkdown(doc.markdownStorageKey);
  const truncated = full.length > CHAR_CAP;
  const docText = truncated ? full.slice(0, CHAR_CAP) : full;
  console.log(`markdown chars: 전체=${full.length} · 주입=${docText.length}${truncated ? " (절단됨)" : ""}`);

  const docB64 = Buffer.from(docText, "utf8").toString("base64");
  const cpArray = Array.from(docText); // 코드포인트 배열 (오프셋 해석 비교용)

  const result = streamText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "file" as const,
            mediaType: "text/plain",
            data: docB64,
            filename: doc.filename,
            providerOptions: {
              anthropic: { citations: { enabled: true }, cacheControl: { type: "ephemeral" } },
            },
          },
          { type: "text" as const, text: QUESTION },
        ],
      },
    ],
    maxOutputTokens: 700,
  });

  const sources: SourcePart[] = [];
  let text = "";
  for await (const part of result.fullStream) {
    const t = (part as { type: string }).type;
    if (t === "source") sources.push(part as SourcePart);
    else if (t === "text-delta") text += (part as { text?: string }).text ?? "";
    else if (t === "error") console.log("[ERROR part]", j(part));
  }

  console.log(`\n[모델 응답]\n${text}`);
  const usage = await result.usage;
  console.log(`[usage] ${j(usage)}`);
  console.log(`[인용(source) 개수] ${sources.length}`);

  sources.forEach((s, i) => {
    const meta = s.providerMetadata?.anthropic ?? {};
    const { citedText, startCharIndex: a, endCharIndex: b } = meta;
    console.log(`\n--- 인용 #${i + 1} ---`);
    console.log(`citedText: ${JSON.stringify(citedText)}`);
    console.log(`offset: [${a}, ${b})`);
    if (typeof a === "number" && typeof b === "number") {
      const bySlice = docText.slice(a, b); // UTF-16 code unit 기준
      const byCodepoint = cpArray.slice(a, b).join(""); // Unicode 코드포인트 기준
      const utf16Match = bySlice === citedText;
      const codepointMatch = byCodepoint === citedText;
      console.log(`원문[UTF-16 slice]: ${JSON.stringify(bySlice)}`);
      if (!utf16Match) console.log(`원문[codepoint slice]: ${JSON.stringify(byCodepoint)}`);
      console.log(`대응 일치: UTF-16=${utf16Match} · codepoint=${codepointMatch}`);
    }
  });

  return { grantId: doc.grantId, title: doc.title, sources: sources.length };
}

async function main() {
  console.log(`# P0-2 grounding-input-spike | model=${MODEL} | charCap=${CHAR_CAP}`);
  const candidates = await findGrantsWithMarkdown(12);
  console.log(`\n[archive markdown 보유 실공고 후보 ${candidates.length}건]`);
  for (const c of candidates) {
    console.log(`  - ${c.grantId} | ${c.title} | bytes=${c.markdownBytes} | key=${c.markdownStorageKey.slice(0, 40)}...`);
  }
  const pick = candidates.filter((c) => (c.markdownBytes ?? 0) > 500).slice(0, 2);
  if (pick.length < 2) {
    console.log("[경고] 충분한 markdown 보유 공고가 2건 미만 — 확보된 만큼만 진행");
  }
  const summary: unknown[] = [];
  for (let i = 0; i < pick.length; i++) {
    summary.push(await runOne(pick[i]!, i + 1));
  }
  console.log("\n[P0-2 요약]", j(summary));
  console.log("\n# P0-2 완료");
}

main().catch((e) => {
  console.error("[P0-2 오류]", e);
  process.exitCode = 1;
});
