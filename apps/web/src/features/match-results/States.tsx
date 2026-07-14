"use client";

import Link from "next/link";
import { FileSearch, RotateCcw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TEASER_FALLBACK_MESSAGE, type TeaserError } from "./logic";

export function LoadingState() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner data-icon="inline-start" />
        지원 가능한 사업을 찾고 있어요. 잠시만 기다려 주세요.
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-[var(--radius-lg)]" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-[var(--radius-lg)]" />
        ))}
      </div>
    </div>
  );
}

export function EmptyState() {
  return (
    <Empty className="mx-auto max-w-md border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileSearch />
        </EmptyMedia>
        <EmptyTitle>조회할 사업자번호가 없어요</EmptyTitle>
        <EmptyDescription>
          첫 화면에서 사업자번호를 입력하면 받을 수 있는 지원사업을 바로 찾아드려요.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/" className={cn(buttonVariants({ size: "lg" }))}>
          사업자번호 입력하러 가기
        </Link>
      </EmptyContent>
    </Empty>
  );
}

export function NoMatchingGrantsState({
  onSubscribe,
  onOpenProfile,
  saving,
}: {
  onSubscribe: () => void;
  onOpenProfile: () => void;
  saving: boolean;
}) {
  return (
    <section className="px-4 pt-[72px] text-center sm:px-10">
      <h2 className="text-[28px] leading-[1.4] font-extrabold tracking-[-0.5px] text-ink-strong">
        아직 조건에 맞는 사업을 찾지 못했어요
      </h2>
      <p className="mx-auto mt-3.5 max-w-[440px] text-[15px] leading-[1.7] text-text-secondary">
        지금 조건에 맞는 공고가 없을 뿐이에요. 새 공고가 들어오면 놓치지 않도록 알려드릴게요.
      </p>
      <div className="mt-[30px] flex flex-col justify-center gap-2.5 sm:flex-row">
        <Button type="button" onClick={onSubscribe} disabled={saving}>
          {saving ? "저장 중…" : "새 공고 알림 받기"}
        </Button>
        <Button type="button" variant="outline" onClick={onOpenProfile}>
          내 정보 확인하기
        </Button>
      </div>
    </section>
  );
}

export function ErrorState({ error, onRetry }: { error: TeaserError | null; onRetry?: (() => void) | undefined }) {
  const isBizIssue = error?.code === "invalid_biz_no";
  const reason = error?.message ?? TEASER_FALLBACK_MESSAGE;
  const title = isBizIssue ? "사업자번호를 다시 확인해 주세요" : "잠시 후 다시 시도해 주세요";
  const steps = isBizIssue
    ? [
        "사업자번호 10자리를 정확히 입력했는지 확인해 주세요.",
        "휴업·폐업 상태이거나 아직 등록되지 않은 번호일 수 있어요.",
        "번호가 정확하다면 잠시 후 다시 시도해 주세요.",
      ]
    : [
        "인터넷 연결 상태를 확인하고 다시 시도해 주세요.",
        "국세청·팝빌 조회가 일시적으로 지연될 수 있어요. 잠시 후 다시 시도하면 대부분 정상 처리돼요.",
        "입력한 사업자번호가 정확한지도 한 번 확인해 주세요.",
      ];

  return (
    <Card className="mx-auto max-w-xl">
      <CardContent className="flex flex-col gap-6 py-8">
        <div className="flex flex-col gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <TriangleAlert className="size-6" strokeWidth={2.25} />
          </div>
          <h2 className="font-heading text-lg font-semibold">{title}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{reason}</p>
        </div>

        <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-muted/30 p-4">
          <div className="text-xs font-semibold text-muted-foreground">이렇게 해보세요</div>
          <ul className="flex flex-col gap-2.5">
            {steps.map((step, index) => (
              <li key={index} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
          {!isBizIssue && onRetry ? (
            <Button type="button" size="lg" onClick={onRetry} className="flex-1">
              <RotateCcw data-icon="inline-start" />
              다시 시도하기
            </Button>
          ) : null}
          <Link
            href="/"
            className={cn(
              buttonVariants({ size: "lg", variant: !isBizIssue && onRetry ? "outline" : "default" }),
              "flex-1",
            )}
          >
            사업자번호 다시 입력
          </Link>
        </div>

        <p className="text-center text-xs leading-5 text-muted-foreground">
          문제가 계속되면 잠시 후 다시 시도하거나 고객센터로 알려주세요.
        </p>
      </CardContent>
    </Card>
  );
}
