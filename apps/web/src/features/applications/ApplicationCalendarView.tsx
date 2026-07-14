"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Link as LinkIcon,
} from "lucide-react";
import type {
  ApplicationPipelineItem,
  ApplicationPipelineResult,
} from "@/lib/server/applications/pipeline";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  WEEKDAYS,
  addMonths,
  calendarDays,
  calendarDday,
  dateKey,
  formatFullDate,
  formatMonth,
  indexEventsByDate,
  monthStart,
} from "@/lib/calendar/dates";

// 순수 날짜 유틸은 서버·클라 공용 모듈(@/lib/calendar/dates)로 이전했다.
// 기존에 이 파일에서 export되던 함수는 계약 유지를 위해 그대로 re-export 한다.
export { dateKey, monthStart, calendarDday } from "@/lib/calendar/dates";

type CalendarEventKind = "deadline" | "reminder";

interface ApplicationCalendarEvent {
  id: string;
  grantId: string;
  date: string;
  dDay: number | null;
  kind: CalendarEventKind;
  title: string;
  detailHref: string;
}

export function ApplicationCalendarView({
  pipeline,
}: {
  pipeline: ApplicationPipelineResult;
}) {
  const todayKey = dateKey(pipeline.generatedAt);
  const events = useMemo(
    () => calendarEventsFromItems(pipeline.items, todayKey),
    [pipeline.items, todayKey]
  );
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(pipeline.generatedAt));
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  const eventsByDate = useMemo(() => indexEventsByDate(events), [events]);
  const upcomingEvents = useMemo(
    () => events.filter((event) => event.date >= todayKey).slice(0, 4),
    [events, todayKey]
  );

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-6 px-5 py-9 sm:px-6 sm:py-13">
      <header className="flex items-center justify-between gap-4 sm:hidden">
        <h1 className="text-xl font-extrabold tracking-[-0.02em] text-foreground">마감 캘린더</h1>
        <a className={buttonVariants({ variant: "link", size: "sm" })} href="/applications">
          리스트로 보기
        </a>
      </header>

      <Card className="gap-5 py-5 sm:gap-6 sm:py-8">
        <CardHeader className="items-center gap-3 px-5 sm:grid-cols-[1fr_auto] sm:px-10">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="text-lg font-extrabold tracking-[-0.02em] sm:text-[22px]">
              {formatMonth(visibleMonth)}
            </CardTitle>
            <div className="flex items-center">
              <Button
                aria-label="이전 달"
                size="icon-sm"
                variant="ghost"
                onClick={() => setVisibleMonth((current) => addMonths(current, -1))}
              >
                <ChevronLeft />
              </Button>
              <Button
                aria-label="다음 달"
                size="icon-sm"
                variant="ghost"
                onClick={() => setVisibleMonth((current) => addMonths(current, 1))}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
          <CardDescription className="sr-only">
            신청 중인 공고의 마감일과 직접 설정한 리마인더를 월별로 확인합니다.
          </CardDescription>
          <CardAction className="row-start-1 hidden items-center gap-3 sm:flex">
            <div className="hidden items-center gap-3 text-xs text-muted-foreground md:flex" aria-label="캘린더 범례">
              <span className="inline-flex items-center gap-1.5">
                <Circle className="size-2 fill-destructive text-destructive" aria-hidden />
                마감
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Circle className="size-2 fill-brand-mint-ink text-brand-mint-ink" aria-hidden />
                리마인더
              </span>
            </div>
            <CalendarExportMenu />
            <a className={cn(buttonVariants({ variant: "link", size: "sm" }), "hidden sm:inline-flex")} href="/applications">
              리스트로 보기
            </a>
          </CardAction>
        </CardHeader>

        <CardContent className="px-5 sm:px-10">
          <div className="grid grid-cols-7 text-center text-xs font-bold text-muted-foreground" aria-hidden>
            {WEEKDAYS.map((weekday, index) => (
              <span className={cn("py-2", index === 0 && "text-destructive")} key={weekday}>{weekday}</span>
            ))}
          </div>
          <div
            className="grid grid-cols-7 border-t border-l border-border"
            aria-label={`${formatMonth(visibleMonth)} 신청 일정`}
          >
            {days.map((day, index) => {
              const dayEvents = day ? eventsByDate.get(day.date) ?? [] : [];
              return (
                <CalendarDayCell
                  day={day}
                  events={dayEvents}
                  key={day?.date ?? `blank-${index}`}
                  today={day?.date === todayKey}
                />
              );
            })}
          </div>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2 sm:hidden" aria-labelledby="upcoming-application-events">
        <h2 className="px-1 text-[13px] font-extrabold text-muted-foreground" id="upcoming-application-events">
          다가오는 일정
        </h2>
        {upcomingEvents.length > 0 ? (
          <div className="flex flex-col gap-2">
            {upcomingEvents.map((event) => <UpcomingEventRow event={event} key={event.id} />)}
          </div>
        ) : (
          <Empty className="min-h-32 border">
            <EmptyHeader>
              <EmptyTitle>다가오는 일정이 없습니다.</EmptyTitle>
              <EmptyDescription>공고를 준비하거나 리마인더를 저장하면 여기에 표시돼요.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <CalendarExportMenu mobile />
        <p className="text-center text-xs text-muted-foreground">iOS · Android · 웹 캘린더에서 사용할 수 있어요.</p>
      </section>
    </div>
  );
}

function CalendarDayCell({
  day,
  events,
  today,
}: {
  day: { date: string; dayOfMonth: number; weekday: number } | null;
  events: ApplicationCalendarEvent[];
  today: boolean;
}) {
  return (
    <div className="min-h-12 min-w-0 border-r border-b border-border p-1.5 sm:min-h-24 sm:p-2">
      {day ? (
        <>
          <time
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums text-foreground",
              day.weekday === 0 && "text-destructive",
              today && "bg-primary font-extrabold text-primary-foreground"
            )}
            dateTime={day.date}
          >
            {day.dayOfMonth}
          </time>
          <div className="mt-1 hidden flex-col gap-1 sm:flex">
            {events.slice(0, 2).map((event) => <CalendarEventPopover event={event} key={event.id} />)}
            {events.length > 2 ? <span className="text-[11px] text-muted-foreground">+{events.length - 2}개</span> : null}
          </div>
          {events.length > 0 ? (
            <div className="mt-1 flex justify-center gap-1 sm:hidden" aria-label={`${events.length}개 일정`}>
              {events.slice(0, 3).map((event) => (
                <Circle
                  aria-hidden
                  className={cn(
                    "size-1.5 fill-current",
                    event.kind === "deadline" ? "text-destructive" : "text-brand-mint-ink"
                  )}
                  key={event.id}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CalendarEventPopover({ event }: { event: ApplicationCalendarEvent }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="w-full justify-start truncate text-left"
            size="xs"
            variant={event.kind === "deadline" ? "destructive" : "secondary"}
          />
        }
      >
        {event.title}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>{event.title}</PopoverTitle>
          <PopoverDescription>
            {formatFullDate(event.date)} · {eventLabel(event)}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex items-center gap-2">
          <a className={buttonVariants({ size: "sm" })} href={event.detailHref}>공고 보기</a>
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/web/applications/${encodeURIComponent(event.grantId)}/calendar`}
          >
            .ics 추가
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UpcomingEventRow({ event }: { event: ApplicationCalendarEvent }) {
  const date = new Date(`${event.date}T00:00:00.000Z`);
  return (
    <Card size="sm" className="py-3">
      <CardContent className="flex items-center gap-3">
        <time className="w-9 shrink-0 text-center" dateTime={event.date}>
          <span className={cn(
            "block text-[11px] font-bold",
            event.kind === "deadline" ? "text-destructive" : "text-brand-mint-ink"
          )}>
            {date.getUTCMonth() + 1}월
          </span>
          <strong className="block text-lg leading-tight tabular-nums text-foreground">{date.getUTCDate()}</strong>
        </time>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-foreground">{event.title}</h3>
          <p className={cn(
            "mt-0.5 text-xs font-bold",
            event.kind === "deadline" ? "text-destructive" : "text-brand-mint-ink"
          )}>
            {eventLabel(event)}
          </p>
        </div>
        <a className={buttonVariants({ variant: "link", size: "sm" })} href={event.detailHref}>공고 보기</a>
      </CardContent>
    </Card>
  );
}

function CalendarExportMenu({ mobile = false }: { mobile?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className={cn(mobile && "w-full")} size={mobile ? "default" : "sm"} variant="secondary" />
        }
      >
        <CalendarDays data-icon="inline-start" />
        내 캘린더에 연동
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLinkItem href="/api/web/applications/calendar">
          <Download />
          .ics 파일 내려받기
        </DropdownMenuLinkItem>
        <DropdownMenuLinkItem href="/api/web/applications/calendar-subscription">
          <LinkIcon />
          구독 URL 내려받기
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function calendarEventsFromItems(
  items: ApplicationPipelineItem[],
  todayKey: string,
): ApplicationCalendarEvent[] {
  const events: ApplicationCalendarEvent[] = [];
  for (const item of items) {
    if (item.stage === "dismissed") continue;
    if (item.applyEnd) {
      const eventDate = dateKey(item.applyEnd);
      events.push({
        id: `${item.grantId}:deadline:${item.applyEnd}`,
        grantId: item.grantId,
        date: eventDate,
        dDay: calendarDday(eventDate, todayKey),
        kind: "deadline",
        title: item.title,
        detailHref: item.detailHref,
      });
    }
    if (item.reminderAt) {
      events.push({
        id: `${item.grantId}:reminder:${item.reminderAt}`,
        grantId: item.grantId,
        date: dateKey(item.reminderAt),
        dDay: null,
        kind: "reminder",
        title: item.title,
        detailHref: item.detailHref,
      });
    }
  }
  return events.sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, "ko"));
}

function eventLabel(event: ApplicationCalendarEvent): string {
  if (event.kind === "reminder") return "리마인더";
  if (event.dDay === null) return "마감";
  if (event.dDay < 0) return "마감됨";
  if (event.dDay === 0) return "마감 · D-Day";
  return `마감 · D-${event.dDay}`;
}
