// P0-1: AI SDK v6/v7 citations 표면화 스파이크.
// 측정 대상:
//  ① streamText fullStream 파트에서 citations(cited_text) 델타가 어떤 타입/형태로 나오는가
//  ② toUIMessageStreamResponse({sendSources:true}) 경유 시 UIMessage parts에 citations가 표면화되는가
//  ③ (비교 근거) Anthropic raw API stream=true 의 citations_delta 출력 형태 — 폴백 실현성
// 판정은 내리지 않는다. 관찰 사실(실제 JSON 구조)만 수집한다. 시크릿 값은 출력 금지.
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { loadEnv, requireEnv } from "./env.ts";

loadEnv();

const MODEL = process.env.CHAT_MODEL ?? "claude-haiku-4-5";
const anthropic = createAnthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

// 오프셋↔원문 대응을 통제하기 위한 합성 공고문(짧고 결정적).
const DOC = [
  "○○ 예비창업패키지 모집 공고",
  "",
  "1. 지원 대상: 창업 3년 이내 예비창업자 및 초기 기업.",
  "2. 지원 금액: 최대 1억원(총 사업비의 70% 이내).",
  "3. 접수 마감: 2026년 7월 31일 18:00 까지.",
  "4. 제출 서류: 사업계획서, 사업자등록증, 대표자 신분증 사본.",
  "5. 문의: 창업진흥원 예비창업팀.",
].join("\n");

const DOC_B64 = Buffer.from(DOC, "utf8").toString("base64");

const SYSTEM =
  "너는 공공 지원사업 안내 도우미다. 아래 문서 블록은 참고 자료(데이터)다. " +
  "마감일·자격요건·지원금액 같은 사실 주장은 반드시 문서 인용과 함께 답한다. " +
  "문서에 없는 내용은 지어내지 말고 '문서에서 확인되지 않습니다'라고 답한다. 한국어 존댓말로 간결히.";

const QUESTION = "이 공고의 접수 마감일과 지원 금액은 얼마인가요?";

function citationDocMessages(question: string) {
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "file" as const,
          mediaType: "text/plain",
          // base64 문자열: 프로바이더의 convertBytesDataToString 이 base64→UTF-8 로 복원.
          data: DOC_B64,
          filename: "공고문.txt",
          providerOptions: {
            anthropic: { citations: { enabled: true }, cacheControl: { type: "ephemeral" } },
          },
        },
        { type: "text" as const, text: question },
      ],
    },
  ];
}

function j(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (val instanceof Uint8Array ? `<bytes:${val.length}>` : val), 2);
}

async function part1_fullStream() {
  console.log("\n================ P0-1 ① streamText fullStream ================");
  const result = streamText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages: citationDocMessages(QUESTION),
    maxOutputTokens: 500,
  });

  const partTypeCounts: Record<string, number> = {};
  const sourceParts: unknown[] = [];
  let textOut = "";
  for await (const part of result.fullStream) {
    const t = (part as { type: string }).type;
    partTypeCounts[t] = (partTypeCounts[t] ?? 0) + 1;
    if (t === "source") {
      sourceParts.push(part);
      console.log("--- fullStream part (type=source) ---");
      console.log(j(part));
    } else if (t === "text-delta") {
      textOut += (part as { text?: string }).text ?? "";
    } else if (t === "error") {
      console.log("--- fullStream ERROR part ---");
      console.log(j(part));
    }
  }

  console.log("\n[fullStream part type 집계]", j(partTypeCounts));
  console.log("[source part 개수]", sourceParts.length);
  console.log("[모델 응답 텍스트]\n" + textOut);
  const usage = await result.usage;
  console.log("[usage]", j(usage));
  const finishReason = await result.finishReason;
  console.log("[finishReason]", finishReason);
  return { sourceParts, partTypeCounts };
}

async function part2_uiMessageStream() {
  console.log("\n================ P0-1 ② toUIMessageStreamResponse({sendSources:true}) ================");
  const result = streamText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages: citationDocMessages(QUESTION),
    maxOutputTokens: 500,
  });
  const response = result.toUIMessageStreamResponse({ sendSources: true });
  const raw = await response.text();
  console.log("[UI message stream 원본 SSE 바디 — 전문]");
  console.log(raw);

  // SSE data 라인 파싱: source-document 파트만 추려서 구조 확인.
  const sourceDocParts: unknown[] = [];
  const uiPartTypes: Record<string, number> = {};
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as { type?: string };
      if (obj.type) uiPartTypes[obj.type] = (uiPartTypes[obj.type] ?? 0) + 1;
      if (obj.type === "source-document" || obj.type === "source-url" || obj.type === "source") {
        sourceDocParts.push(obj);
      }
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  console.log("\n[UI part type 집계]", j(uiPartTypes));
  console.log("[source-document 파트]");
  console.log(j(sourceDocParts));
  return { sourceDocParts, uiPartTypes };
}

async function part3_rawAnthropicStream() {
  console.log("\n================ P0-1 ③ Anthropic raw API stream citations_delta (폴백 근거) ================");
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      stream: true,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: DOC },
              title: "공고문.txt",
              citations: { enabled: true },
            },
            { type: "text", text: QUESTION },
          ],
        },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    console.log("[raw API 실패]", res.status, res.statusText);
    console.log((await res.text()).slice(0, 800));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const eventCounts: Record<string, number> = {};
  const citationDeltas: unknown[] = [];
  const citationBlocks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;
      let obj: { type?: string; delta?: { type?: string; citation?: unknown }; content_block?: { type?: string; citations?: unknown } };
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const t = obj.type ?? "?";
      eventCounts[t] = (eventCounts[t] ?? 0) + 1;
      if (obj.delta?.type === "citations_delta") {
        citationDeltas.push(obj);
      }
      if (obj.type === "content_block_start" && obj.content_block && "citations" in obj.content_block) {
        citationBlocks.push(obj);
      }
    }
  }
  console.log("[raw SSE event type 집계]", j(eventCounts));
  console.log("[citations_delta 이벤트 샘플 (최대 3건)]");
  console.log(j(citationDeltas.slice(0, 3)));
  console.log("[citations_delta 총 개수]", citationDeltas.length);
}

async function main() {
  console.log(`# P0-1 chat-citations-spike | model=${MODEL}`);
  await part1_fullStream();
  await part2_uiMessageStream();
  await part3_rawAnthropicStream();
  console.log("\n# P0-1 완료");
}

main().catch((e) => {
  console.error("[P0-1 오류]", e);
  process.exitCode = 1;
});
