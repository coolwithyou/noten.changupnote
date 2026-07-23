"use client"

import ReactMarkdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-3 break-words text-sm leading-7 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-5 [&_ol]:list-decimal [&_p]:whitespace-pre-wrap [&_ul]:list-disc">
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ children: label, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {label}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
