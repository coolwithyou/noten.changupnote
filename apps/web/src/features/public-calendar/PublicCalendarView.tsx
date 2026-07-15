"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  ExternalLink,
  RotateCcw,
  Search,
} from "lucide-react";
import type { GrantSource } from "@cunote/contracts";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  WEEKDAYS,
  calendarDays,
  formatFullDate,
  formatMonth,
  indexEventsByDate,
  monthStart,
} from "@/lib/calendar/dates";
import {
  serializePublicCalendarQuery,
  type PublicCalendarFilters,
  type PublicCalendarStatus,
} from "@/lib/publicCalendar/query";
// 타입만 가져온다(import type은 컴파일 시 제거되어 서버 모듈이 클라 번들에 포함되지 않음).
import type {
  PublicCalendarEvent,
  PublicCalendarFacetOption,
  PublicCalendarFacets,
} from "@/lib/server/publicCalendar/publicCalendarCore";
import {
  buildCalendarConnectLinks,
  type PublicCalendarConnectLinks,
} from "./publicCalendarLinks";

// 지역 facet의 "전국"은 시도 코드가 아니라 정보용(항상 노출) 옵션이라 토글 대상이 아니다.
const NATIONWIDE_FACET_VALUE = "nationwide";

export interface PublicCalendarViewProps {
  /** 현재 보고 있는 월 "YYYY-MM". */
  monthKey: string;
  /** 현재 KST 월 "YYYY-MM" — 직렬화 시 기본값(month 생략) 판정에 쓴다. */
  currentMonthKey: string;
  /** 현재 KST 날짜 "YYYY-MM-DD". */
  todayKey: string;
  filters: PublicCalendarFilters;
  facets: PublicCalendarFacets;
  /** 필터 적용 + 해당 월 날짜에 걸치는 이벤트(그리드용). */
  monthEvents: PublicCalendarEvent[];
  /** 필터 적용 + todayKey 이후 최대 5건(모바일 "다가오는 일정"용). */
  upcomingEvents: PublicCalendarEvent[];
  /** 이 달 전체 이벤트 수(필터 미적용). */
  totalMonthEvents: number;
  /** 필터 적용 결과 수. */
  filteredCount: number;
  /** 필터 보존 이전 달 링크. 하한 경계면 null(비활성). */
  prevMonthHref: string | null;
  /** 필터 보존 다음 달 링크. 상한 경계면 null(비활성). */
  nextMonthHref: string | null;
}

export function PublicCalendarView({
  monthKey,
  currentMonthKey,
  todayKey,
  filters,
  facets,
  monthEvents,
  upcomingEvents,
  totalMonthEvents,
  filteredCount,
  prevMonthHref,
  nextMonthHref,
}: PublicCalendarViewProps) {
  const router = useRouter();
  const month = useMemo(() => monthStart(monthKey), [monthKey]);
  const days = useMemo(() => calendarDays(month), [month]);
  const eventsByDate = useMemo(() => indexEventsByDate(monthEvents), [monthEvents]);

  const hasFilters =
    filters.regions.length > 0 ||
    filters.categories.length > 0 ||
    filters.sources.length > 0 ||
    filters.statuses.length > 0;

  function pushFilters(next: PublicCalendarFilters): void {
    const query = serializePublicCalendarQuery(monthKey, next, { currentMonthKey });
    router.push(query ? `/calendar?${query}` : "/calendar", { scroll: false });
  }

  const resetHref = calendarHref(
    serializePublicCalendarQuery(monthKey, emptyFilters(), { currentMonthKey }),
  );

  const isEmpty = filteredCount === 0;

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-extrabold tracking-[-0.02em] text-foreground sm:text-2xl">
          지원사업 마감 캘린더
        </h1>
        <p className="text-sm text-text-secondary">
          로그인 없이, 이번 달 마감과 접수 시작 공고를 한눈에 확인하세요.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="캘린더 필터">
        <FilterDropdown
          label="지역"
          options={facets.regions.map((option) => ({
            ...option,
            disabled: option.value === NATIONWIDE_FACET_VALUE,
          }))}
          onToggle={(value) =>
            pushFilters({ ...filters, regions: toggleValue(filters.regions, value) })
          }
        />
        <FilterDropdown
          label="분야"
          options={facets.categories}
          onToggle={(value) =>
            pushFilters({ ...filters, categories: toggleValue(filters.categories, value) })
          }
        />
        <FilterDropdown
          label="소스"
          options={facets.sources}
          onToggle={(value) =>
            pushFilters({
              ...filters,
              sources: toggleValue(filters.sources, value as GrantSource),
            })
          }
        />
        <FilterDropdown
          label="상태"
          options={facets.statuses}
          onToggle={(value) =>
            pushFilters({
              ...filters,
              statuses: toggleValue(filters.statuses, value as PublicCalendarStatus),
            })
          }
        />
        <span className="ml-1 text-sm font-semibold text-text-secondary tabular-nums">
          {filteredCount.toLocaleString("ko-KR")}건
          {hasFilters && totalMonthEvents !== filteredCount ? (
            <span className="text-text-tertiary"> / {totalMonthEvents.toLocaleString("ko-KR")}건</span>
          ) : null}
        </span>
        {hasFilters ? (
          <a
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            href={resetHref}
          >
            <RotateCcw data-icon="inline-start" />
            필터 초기화
          </a>
        ) : null}
      </div>

      <Card className="gap-5 py-5 sm:gap-6 sm:py-8">
        <CardHeader className="items-center gap-3 px-5 sm:grid-cols-[1fr_auto] sm:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="text-lg font-extrabold tracking-[-0.02em] sm:text-[22px]">
              {formatMonth(month)}
            </CardTitle>
            <div className="flex items-center">
              <MonthNavButton
                direction="prev"
                href={prevMonthHref}
                label="이전 달"
              />
              <MonthNavButton
                direction="next"
                href={nextMonthHref}
                label="다음 달"
              />
            </div>
          </div>
          <CardDescription className="sr-only">
            {formatMonth(month)}에 마감되거나 접수를 시작하는 공공 지원사업 일정입니다.
          </CardDescription>
          <CardAction className="row-start-1 hidden items-center gap-3 sm:flex">
            <Legend />
            <CalendarConnectMenu filters={filters} />
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 px-5 sm:px-8">
          <div
            className="grid grid-cols-7 text-center text-xs font-bold text-muted-foreground"
            aria-hidden
          >
            {WEEKDAYS.map((weekday, index) => (
              <span className={cn("py-2", index === 0 && "text-destructive")} key={weekday}>
                {weekday}
              </span>
            ))}
          </div>
          <div
            className="grid grid-cols-7 border-t border-l border-border"
            aria-label={`${formatMonth(month)} 지원사업 마감·접수 일정`}
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

          {isEmpty ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>이 달에는 표시할 공고가 없어요.</EmptyTitle>
                <EmptyDescription>
                  필터를 바꾸거나 다른 달을 확인해 보세요.
                </EmptyDescription>
              </EmptyHeader>
              {hasFilters ? (
                <EmptyContent>
                  <a
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                    href={resetHref}
                  >
                    <RotateCcw data-icon="inline-start" />
                    필터 초기화
                  </a>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : null}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2 sm:hidden" aria-labelledby="public-upcoming-events">
        <h2
          className="px-1 text-[13px] font-extrabold text-muted-foreground"
          id="public-upcoming-events"
        >
          다가오는 일정
        </h2>
        {upcomingEvents.length > 0 ? (
          <div className="flex flex-col gap-2">
            {upcomingEvents.map((event) => (
              <UpcomingEventRow event={event} key={event.id} />
            ))}
          </div>
        ) : (
          <Empty className="min-h-32 border">
            <EmptyHeader>
              <EmptyTitle>다가오는 일정이 없어요.</EmptyTitle>
              <EmptyDescription>
                다른 달을 확인하거나 필터를 조정해 보세요.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <CalendarConnectMenu filters={filters} mobile />
        <p className="text-center text-xs text-muted-foreground">
          iOS · Android · 웹 캘린더에서 사용할 수 있어요.
        </p>
      </section>
    </div>
  );
}

/**
 * "내 캘린더에 연동" 드롭다운 — 현재 필터가 반영된 공개 ICS 구독 링크 4종.
 * origin은 SSR에 싣지 않고 드롭다운 오픈 시점 window.location.origin으로 조립한다
 * (hydration 불일치 회피). 콘텐츠는 포털이라 오픈 후에만 렌더되므로 늦은 조립으로 충분하다.
 */
function CalendarConnectMenu({
  filters,
  mobile = false,
}: {
  filters: PublicCalendarFilters;
  mobile?: boolean;
}) {
  const [links, setLinks] = useState<PublicCalendarConnectLinks | null>(null);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setLinks(buildCalendarConnectLinks(window.location.origin, filters));
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button className={cn(mobile && "w-full")} size={mobile ? "default" : "sm"} variant="secondary" />
        }
      >
        <CalendarDays data-icon="inline-start" />
        내 캘린더에 연동
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        {links ? (
          <>
            <DropdownMenuLinkItem href={links.google} rel="noopener noreferrer" target="_blank">
              <ExternalLink />
              Google 캘린더
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem href={links.webcal}>
              <CalendarPlus />
              Apple 캘린더
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem href={links.outlook} rel="noopener noreferrer" target="_blank">
              <ExternalLink />
              Outlook
            </DropdownMenuLinkItem>
            <DropdownMenuLinkItem href={links.ics}>
              <Download />
              .ics 파일 내려받기
            </DropdownMenuLinkItem>
            <DropdownMenuSeparator />
            <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs leading-relaxed text-muted-foreground">
              현재 필터가 그대로 적용된 구독 주소예요. 새 일정이 자동으로 동기화돼요.
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Legend() {
  return (
    <div
      className="hidden items-center gap-3 text-xs text-muted-foreground md:flex"
      aria-label="캘린더 범례"
    >
      <span className="inline-flex items-center gap-1.5">
        <Circle className="size-2 fill-destructive text-destructive" aria-hidden />
        마감
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Circle className="size-2 fill-success text-success" aria-hidden />
        접수 시작
      </span>
    </div>
  );
}

function MonthNavButton({
  direction,
  href,
  label,
}: {
  direction: "prev" | "next";
  href: string | null;
  label: string;
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  if (!href) {
    return (
      <span
        aria-disabled
        aria-label={label}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "pointer-events-none opacity-40",
        )}
      >
        <Icon />
      </span>
    );
  }
  return (
    <a
      aria-label={label}
      className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      href={href}
    >
      <Icon />
    </a>
  );
}

type FilterOption = PublicCalendarFacetOption & { disabled?: boolean };

function FilterDropdown({
  label,
  options,
  onToggle,
}: {
  label: string;
  options: FilterOption[];
  onToggle: (value: string) => void;
}) {
  const selectedCount = options.filter((option) => option.selected).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        {label}
        {selectedCount > 0 ? (
          <span className="tabular-nums text-primary"> · {selectedCount}</span>
        ) : null}
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(60vh,22rem)] min-w-56 overflow-y-auto"
      >
        {options.length === 0 ? (
          <DropdownMenuLabel>표시할 항목이 없어요</DropdownMenuLabel>
        ) : (
          options.map((option) =>
            option.disabled ? (
              <DropdownMenuItem closeOnClick={false} disabled key={option.value}>
                <span className="flex-1 truncate text-muted-foreground">{option.label}</span>
                <FacetCount count={option.count} />
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                closeOnClick={false}
                key={option.value}
                onClick={() => onToggle(option.value)}
              >
                <Check aria-hidden className={cn(!option.selected && "opacity-0")} />
                <span className="flex-1 truncate">{option.label}</span>
                <FacetCount count={option.count} />
              </DropdownMenuItem>
            ),
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FacetCount({ count }: { count: number }) {
  return (
    <span className="ml-2 shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
      {count.toLocaleString("ko-KR")}
    </span>
  );
}

function CalendarDayCell({
  day,
  events,
  today,
}: {
  day: { date: string; dayOfMonth: number; weekday: number } | null;
  events: PublicCalendarEvent[];
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
              today && "bg-primary font-extrabold text-primary-foreground",
            )}
            dateTime={day.date}
          >
            {day.dayOfMonth}
          </time>
          <div className="mt-1 hidden flex-col gap-1 sm:flex">
            {events.slice(0, 2).map((event) => (
              <EventChip event={event} key={event.id} />
            ))}
            {events.length > 2 ? (
              <DayEventsDialog events={events} extra={events.length - 2} />
            ) : null}
          </div>
          {events.length > 0 ? (
            <div
              className="mt-1 flex justify-center gap-1 sm:hidden"
              aria-label={`${events.length}개 일정`}
            >
              {events.slice(0, 3).map((event) => (
                <Circle
                  aria-hidden
                  className={cn(
                    "size-1.5 fill-current",
                    event.kind === "deadline" ? "text-destructive" : "text-success",
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

function EventChip({ event }: { event: PublicCalendarEvent }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button className={chipClassName(event)} size="xs" variant="secondary" />
        }
      >
        {event.title}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-4">
        <EventDetailBody event={event} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * "+N개" → 그날 전체 일정 모달. 하루 100건이 넘는 날이 실재해(7/1 156건)
 * 팝오버 리스트로는 감당이 안 된다 — 고정 높이 모달 + 검색으로 살펴본다.
 * 스크롤은 min-h-0 flex 자식의 overflow-y-auto로 확정한다
 * (base-ui ScrollArea는 루트 max-h만으로는 viewport 높이가 잡히지 않음).
 */
function DayEventsDialog({
  events,
  extra,
}: {
  events: PublicCalendarEvent[];
  extra: number;
}) {
  const [query, setQuery] = useState("");
  const date = events[0]?.date;
  const normalized = query.trim().toLowerCase();
  const visibleEvents = normalized
    ? events.filter((event) => eventSearchText(event).includes(normalized))
    : events;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) setQuery("");
      }}
    >
      <DialogTrigger
        render={
          <Button
            className="w-full justify-start text-muted-foreground"
            size="xs"
            variant="ghost"
          />
        }
      >
        +{extra}개
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(80vh,42rem)] w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base font-extrabold tracking-[-0.01em]">
            {date ? formatFullDate(date) : ""} 일정 {events.length.toLocaleString("ko-KR")}건
          </DialogTitle>
          <DialogDescription>
            제목·기관·분야·지역으로 검색해 살펴보세요.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 px-5 pt-3 pb-2">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="일정 검색"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="공고 제목, 기관, 분야, 지역 검색"
              value={query}
            />
          </InputGroup>
          {normalized ? (
            <p className="px-1 text-xs text-muted-foreground tabular-nums">
              {visibleEvents.length.toLocaleString("ko-KR")}건 일치
            </p>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {visibleEvents.length > 0 ? (
            <ul className="flex flex-col">
              {visibleEvents.map((event) => (
                <DayEventRow event={event} key={event.id} />
              ))}
            </ul>
          ) : (
            <Empty className="min-h-32">
              <EmptyHeader>
                <EmptyTitle>검색 결과가 없어요.</EmptyTitle>
                <EmptyDescription>다른 검색어로 시도해 보세요.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <DialogFooter className="border-t border-border px-5 py-3 sm:justify-between sm:gap-3">
          <p className="hidden self-center text-xs text-muted-foreground sm:block">
            사업자번호를 입력하면 맞는 공고만 골라 드려요.
          </p>
          <a className={cn(buttonVariants({ size: "sm" }))} href="/">
            내 조건으로 확인
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 모달 리스트 행 — 색점 + 제목 + 일정·기관·분야 한 줄 + 원문 링크. */
function DayEventRow({ event }: { event: PublicCalendarEvent }) {
  const closed = event.status === "closed";
  const meta = [eventScheduleLabel(event), event.agency, event.categoryL1]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-b border-border-subtle py-2.5 last:border-b-0",
        closed && "opacity-60",
      )}
    >
      <Circle
        aria-hidden
        className={cn(
          "size-2 shrink-0 fill-current",
          closed
            ? "text-muted-foreground"
            : event.kind === "deadline"
              ? "text-destructive"
              : "text-success",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-foreground">{event.title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      {event.url ? (
        <a
          className={cn(buttonVariants({ variant: "link", size: "sm" }), "shrink-0")}
          href={event.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          원문
          <ExternalLink data-icon="inline-end" />
        </a>
      ) : null}
    </li>
  );
}

function eventSearchText(event: PublicCalendarEvent): string {
  return [
    event.title,
    event.agency ?? "",
    event.categoryL1 ?? "",
    event.regionLabels.join(" "),
    event.sourceLabel,
  ]
    .join(" ")
    .toLowerCase();
}

function EventDetailBody({ event }: { event: PublicCalendarEvent }) {
  const closed = event.status === "closed";
  const hasMeta =
    Boolean(event.agency) ||
    Boolean(event.categoryL1) ||
    event.regionLabels.length > 0 ||
    Boolean(event.supportAmountLabel);
  return (
    <div className={cn("flex flex-col gap-3", closed && "opacity-70")}>
      <div className="flex flex-col gap-1">
        <strong className="text-sm font-extrabold tracking-[-0.01em] text-foreground">
          {event.title}
        </strong>
        <p
          className={cn(
            "text-xs font-bold",
            closed
              ? "text-muted-foreground"
              : event.kind === "deadline"
                ? "text-destructive"
                : "text-success",
          )}
        >
          {eventScheduleLabel(event)}
        </p>
      </div>
      {hasMeta ? (
        <dl className="grid gap-1 text-xs text-muted-foreground">
          {event.agency ? <MetaRow desc={event.agency} term="기관" /> : null}
          {event.categoryL1 ? <MetaRow desc={event.categoryL1} term="분야" /> : null}
          {event.regionLabels.length > 0 ? (
            <MetaRow desc={event.regionLabels.join(", ")} term="지역" />
          ) : null}
          {event.supportAmountLabel ? (
            <MetaRow desc={event.supportAmountLabel} term="지원금" />
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {event.url ? (
          <a
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            href={event.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLink data-icon="inline-start" />
            원문 보기
          </a>
        ) : null}
        <a className={cn(buttonVariants({ size: "sm" }))} href="/">
          내 조건으로 확인
        </a>
      </div>
    </div>
  );
}

function MetaRow({ term, desc }: { term: string; desc: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 font-semibold text-foreground">{term}</dt>
      <dd className="min-w-0 flex-1">{desc}</dd>
    </div>
  );
}

function UpcomingEventRow({ event }: { event: PublicCalendarEvent }) {
  const date = new Date(`${event.date}T00:00:00.000Z`);
  const closed = event.status === "closed";
  const accentClass = closed
    ? "text-muted-foreground"
    : event.kind === "deadline"
      ? "text-destructive"
      : "text-success";
  return (
    <Card className="py-3" size="sm">
      <CardContent className="flex items-center gap-3">
        <time className="w-9 shrink-0 text-center" dateTime={event.date}>
          <span className={cn("block text-[11px] font-bold", accentClass)}>
            {date.getUTCMonth() + 1}월
          </span>
          <strong className="block text-lg leading-tight tabular-nums text-foreground">
            {date.getUTCDate()}
          </strong>
        </time>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-foreground">{event.title}</h3>
          <p className={cn("mt-0.5 text-xs font-bold", accentClass)}>
            {eventScheduleLabel(event)}
          </p>
        </div>
        {event.url ? (
          <a
            className={cn(buttonVariants({ variant: "link", size: "sm" }))}
            href={event.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            원문
          </a>
        ) : (
          <a className={cn(buttonVariants({ variant: "link", size: "sm" }))} href="/">
            확인
          </a>
        )}
      </CardContent>
    </Card>
  );
}

// deadline=마감 소프트(danger), start=접수 시작 소프트(success). 과거(closed) 이벤트는 흐리게.
function chipClassName(event: PublicCalendarEvent): string {
  const closed = event.status === "closed";
  return cn(
    "w-full justify-start truncate text-left",
    event.kind === "deadline"
      ? "bg-danger-soft text-destructive hover:bg-danger-soft aria-expanded:bg-danger-soft"
      : "bg-success-soft text-success hover:bg-success-soft aria-expanded:bg-success-soft",
    closed && "opacity-60",
  );
}

function eventScheduleLabel(event: PublicCalendarEvent): string {
  const dateText = formatFullDate(event.date);
  if (event.kind === "start") return `접수 시작: ${dateText}`;
  const dday = deadlineDdayLabel(event);
  return dday ? `마감: ${dateText} · ${dday}` : `마감: ${dateText}`;
}

function deadlineDdayLabel(event: PublicCalendarEvent): string {
  if (event.status === "closed") return "마감됨";
  if (event.dDay === null) return "";
  if (event.dDay < 0) return "마감됨";
  if (event.dDay === 0) return "D-Day";
  return `D-${event.dDay}`;
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function calendarHref(query: string): string {
  return query ? `/calendar?${query}` : "/calendar";
}

function emptyFilters(): PublicCalendarFilters {
  return { regions: [], categories: [], sources: [], statuses: [] };
}
