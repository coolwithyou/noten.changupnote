"use client";

import { useMemo, useState } from "react";
import { Inbox, Quote } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DashboardNonLessonItem } from "@/lib/server/knowledge/knowledgeDashboardData";
import { NON_LESSON_KIND_ORDER, labelForNonLessonKind } from "./knowledgeLabels";

interface NonLessonPanelProps {
  items: DashboardNonLessonItem[];
}

/** (g) 비-lesson 항목 — kind 탭(제품 피드백 / FAQ 후보 / 작성 예문). */
export function NonLessonPanel({ items }: NonLessonPanelProps) {
  // kind 목록: 알려진 순서 우선, 그 밖의 kind 는 뒤에 등장 순으로.
  const kinds = useMemo(() => {
    const present = new Set(items.map((i) => i.kind));
    const known = NON_LESSON_KIND_ORDER.filter((k) => present.has(k));
    const extra = [...present].filter((k) => !NON_LESSON_KIND_ORDER.includes(k));
    return [...known, ...extra];
  }, [items]);

  const [tab, setTab] = useState<string>(kinds[0] ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>비-lesson 항목</CardTitle>
        <CardDescription>
          lesson 으로 승격되지 않은 제품 피드백·FAQ 후보·작성 예문입니다 (참고용, 지식 주입 대상 아님).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {kinds.length === 0 ? (
          <Empty className="border border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>비-lesson 항목이 없습니다</EmptyTitle>
              <EmptyDescription>추출 시 lesson 이 아닌 항목이 분류되면 이곳에 모입니다.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            <TabsList>
              {kinds.map((kind) => {
                const count = items.filter((i) => i.kind === kind).length;
                return (
                  <TabsTrigger key={kind} value={kind}>
                    {labelForNonLessonKind(kind)}
                    <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-foreground/5 px-1 text-[11px] tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
            {kinds.map((kind) => {
              const kindItems = items.filter((i) => i.kind === kind);
              return (
                <TabsContent key={kind} value={kind} className="pt-3">
                  {kindItems.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      이 분류의 항목이 없습니다.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {kindItems.map((item, index) => (
                        <li
                          key={`${item.sourceId}-${index}`}
                          className="rounded-[var(--radius-lg)] border border-border p-3.5"
                        >
                          <p className="text-sm leading-6 text-foreground/90">{item.content}</p>
                          {item.quote ? (
                            <blockquote className="mt-2.5 rounded-r-[var(--radius-md)] border-l-2 border-border bg-muted/30 px-3 py-2 text-xs text-foreground/80">
                              <p className="flex items-start gap-1.5 whitespace-pre-wrap leading-5">
                                <Quote className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
                                {`“${item.quote}”`}
                              </p>
                              <footer className="mt-1.5 text-[11px] text-muted-foreground">
                                {item.sourceTitle}
                                {typeof item.page === "number" ? ` · p.${item.page}` : ""}
                              </footer>
                            </blockquote>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
