"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// dev 전용 마크다운 뷰 — react-markdown 은 이 실험실 밖에서 import 하지 않는다.
// 스타일은 태그 오버라이드 대신 래퍼의 Tailwind arbitrary variant 로만 입힌다
// (raw 태그를 소스에 쓰지 않기 위함 — 드리프트 스캔 0건 유지).
const PROSE_CLASSES = [
  "text-sm leading-relaxed text-foreground",
  // 제목 위계
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:first:mt-0",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-1.5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:first:mt-0",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold",
  // 본문·리스트
  "[&_p]:my-2.5",
  "[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-1",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-5 [&_hr]:border-border",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_strong]:font-semibold",
  // 코드
  "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  // 표 (GFM)
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top",
].join(" ");

export function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="overflow-x-auto">
      <div className={PROSE_CLASSES}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
