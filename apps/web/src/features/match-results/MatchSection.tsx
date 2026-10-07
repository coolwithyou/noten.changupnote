"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const HEADING_CLASS = "text-[17px] font-extrabold tracking-[-0.3px] text-ink-strong";
const COUNT_CLASS = "shrink-0 text-[13px] text-text-secondary tabular-nums";

/**
 * 기회 맵 섹션(디자인 01 `.sec`): `h2` 제목 + 우측 건수 캡션 + 본문. `collapsible`이면 `<details>`처럼
 * 제목 앞 캐럿(▸/▾)으로 접고 편다. 섹션 간 간격 26px.
 */
export function MatchSection({
  title,
  count,
  description,
  collapsible = false,
  defaultOpen = true,
  children,
  className,
}: {
  title: string;
  count?: string | null;
  description?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      {description ? <p className="mb-3 text-[13px] leading-[1.55] text-text-secondary">{description}</p> : null}
      {children}
    </>
  );

  if (!collapsible) {
    return (
      <section aria-label={title} className={cn("mt-[26px]", className)}>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className={HEADING_CLASS}>{title}</h2>
          {count ? <span className={COUNT_CLASS}>{count}</span> : null}
        </div>
        {body}
      </section>
    );
  }

  return (
    <section aria-label={title} className={cn("mt-[26px]", className)}>
      <Collapsible defaultOpen={defaultOpen}>
        <CollapsibleTrigger className="group/section mb-3 flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/20">
          <h2 className={cn(HEADING_CLASS, "flex items-center gap-1")}>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-text-quaternary transition-transform group-data-[panel-open]/section:rotate-90"
            />
            {title}
          </h2>
          {count ? <span className={COUNT_CLASS}>{count}</span> : null}
        </CollapsibleTrigger>
        <CollapsibleContent>{body}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}
