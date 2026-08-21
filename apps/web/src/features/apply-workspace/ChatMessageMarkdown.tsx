import React, { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Separator } from "@/components/ui/separator";

const REMARK_PLUGINS = [remarkGfm];

/**
 * 스트리밍 중에도 같은 DOM 구조를 유지하는 채팅 전용 Markdown 렌더러.
 * raw HTML과 원격 이미지는 렌더하지 않아 모델 응답이 패널 바깥 레이아웃에 영향을 주지 않게 한다.
 */
export const ChatMessageMarkdown = memo(function ChatMessageMarkdown({
  children,
}: {
  children: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      skipHtml
      components={{
        p: ({ children: content }) => (
          <p className="leading-6 text-pretty [&:not(:first-child)]:mt-2">{content}</p>
        ),
        h1: ({ children: content }) => (
          <p className="mt-3 font-semibold leading-6 first:mt-0">{content}</p>
        ),
        h2: ({ children: content }) => (
          <p className="mt-3 font-semibold leading-6 first:mt-0">{content}</p>
        ),
        h3: ({ children: content }) => (
          <p className="mt-2 font-semibold leading-6 first:mt-0">{content}</p>
        ),
        ul: ({ children: content }) => (
          <ul className="my-2 flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground">
            {content}
          </ul>
        ),
        ol: ({ children: content }) => (
          <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:font-medium marker:text-muted-foreground">
            {content}
          </ol>
        ),
        li: ({ children: content }) => <li className="min-w-0 pl-0.5 leading-6">{content}</li>,
        blockquote: ({ children: content }) => (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
            {content}
          </blockquote>
        ),
        a: ({ children: content, href }) => {
          const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
          return (
            <a
              href={href}
              className="font-medium break-all underline underline-offset-4 hover:text-primary"
              {...(isExternal ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {content}
            </a>
          );
        },
        pre: ({ children: content }) => (
          <pre className="my-2 max-w-full overflow-x-auto rounded-[var(--radius-md)] bg-muted p-3 text-xs leading-5">
            {content}
          </pre>
        ),
        code: ({ children: content, className, ...props }) => (
          <code
            className={className ?? "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]"}
            {...props}
          >
            {content}
          </code>
        ),
        table: ({ children: content }) => (
          <table className="my-2 block max-w-full overflow-x-auto border-collapse text-left text-xs">
            {content}
          </table>
        ),
        th: ({ children: content }) => (
          <th className="border border-border bg-muted px-2 py-1.5 font-semibold">{content}</th>
        ),
        td: ({ children: content }) => (
          <td className="border border-border px-2 py-1.5 align-top">{content}</td>
        ),
        hr: () => <Separator className="my-3" />,
        img: ({ alt }) => (
          <span className="text-xs text-muted-foreground">{alt ? `이미지: ${alt}` : "이미지"}</span>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
});
