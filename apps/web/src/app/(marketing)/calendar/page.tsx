import type { Metadata } from "next";
import { BizLookupProvider } from "@/features/landing/biz-lookup-context";
import { FinalCta } from "@/features/landing/final-cta";
import { LandingFooter } from "@/features/landing/marketing-sections";
import { PublicCalendarView } from "@/features/public-calendar/PublicCalendarView";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { dateKey, monthKey, parseMonthKey } from "@/lib/calendar/dates";
import {
  CALENDAR_MAX_FUTURE_MONTHS,
  CALENDAR_MIN_MONTH,
  parsePublicCalendarSearchParams,
  serializePublicCalendarQuery,
  type PublicCalendarFilters,
  type PublicCalendarSearchParams,
} from "@/lib/publicCalendar/query";
import {
  applyPublicCalendarFilters,
  buildPublicCalendarEvents,
  buildPublicCalendarFacets,
  type PublicCalendarEvent,
} from "@/lib/server/publicCalendar/publicCalendarCore";
import {
  loadPublicCalendarMonth,
  PublicCalendarDataError,
} from "@/lib/server/publicCalendar/publicCalendarData";

export const dynamic = "force-dynamic";

const META_DESCRIPTION =
  "전국 공공 지원사업의 접수 시작·마감 일정을 월별 캘린더로 확인하세요. 사업자 등록번호 없이, 로그인 없이 무료로 열람할 수 있습니다.";

interface PublicCalendarPageProps {
  searchParams: Promise<PublicCalendarSearchParams>;
}

export async function generateMetadata({
  searchParams,
}: PublicCalendarPageProps): Promise<Metadata> {
  const currentMonthKey = monthKey(new Date());
  const resolved = await searchParams;
  const { month } = parsePublicCalendarSearchParams(resolved, currentMonthKey);
  const parts = parseMonthKey(month) ?? parseMonthKey(currentMonthKey);
  const title = parts
    ? `${parts.year}년 ${parts.month}월 지원사업 마감 캘린더 | 창업노트`
    : "지원사업 마감 캘린더 | 창업노트";
  // canonical에는 필터를 싣지 않는다(중복 색인 방지). 현재 월이면 파라미터 없는 정규 URL.
  const canonical = month === currentMonthKey ? "/calendar" : `/calendar?month=${month}`;
  return {
    title,
    description: META_DESCRIPTION,
    alternates: { canonical },
  };
}

export default async function PublicCalendarPage({
  searchParams,
}: PublicCalendarPageProps) {
  const now = new Date();
  const currentMonthKey = monthKey(now);
  const todayKey = dateKey(now.toISOString());
  const resolved = await searchParams;
  const { month, filters } = parsePublicCalendarSearchParams(resolved, currentMonthKey);

  let allEvents: PublicCalendarEvent[] | null = null;
  try {
    const rows = await loadPublicCalendarMonth({ monthKey: month });
    allEvents = buildPublicCalendarEvents(rows, todayKey);
  } catch (error) {
    // 월 행 폭주(503) 등 데이터 계층 도메인 에러는 500 스택 대신 안내 UI로 흡수한다.
    if (!(error instanceof PublicCalendarDataError)) throw error;
  }

  return (
    <BizLookupProvider>
      <main className="w-full overflow-x-hidden">
        {allEvents ? (
          <PublicCalendarView
            {...buildViewProps({ month, currentMonthKey, todayKey, filters, allEvents })}
          />
        ) : (
          <CalendarUnavailableNotice />
        )}
        <FinalCta />
        <LandingFooter />
      </main>
    </BizLookupProvider>
  );
}

function buildViewProps({
  month,
  currentMonthKey,
  todayKey,
  filters,
  allEvents,
}: {
  month: string;
  currentMonthKey: string;
  todayKey: string;
  filters: PublicCalendarFilters;
  allEvents: PublicCalendarEvent[];
}) {
  // 그리드·요약·facet은 "이 달 날짜에 걸치는" 이벤트만 대상으로 한다(다른 달 마감/시작은 제외).
  const monthAll = allEvents.filter((event) => event.date.slice(0, 7) === month);
  const facets = buildPublicCalendarFacets(monthAll, filters);
  const monthFiltered = applyPublicCalendarFilters(monthAll, filters);
  // "다가오는 일정"은 오늘 이후 이벤트에서(월 경계 무관) 5건.
  const upcomingEvents = applyPublicCalendarFilters(allEvents, filters)
    .filter((event) => event.date >= todayKey)
    .slice(0, 5);

  const prevKey = shiftMonthKey(month, -1);
  const nextKey = shiftMonthKey(month, 1);
  const maxKey = shiftMonthKey(currentMonthKey, CALENDAR_MAX_FUTURE_MONTHS);

  return {
    monthKey: month,
    currentMonthKey,
    todayKey,
    filters,
    facets,
    monthEvents: monthFiltered,
    upcomingEvents,
    totalMonthEvents: monthAll.length,
    filteredCount: monthFiltered.length,
    prevMonthHref:
      prevKey >= CALENDAR_MIN_MONTH ? monthHref(prevKey, filters, currentMonthKey) : null,
    nextMonthHref: nextKey <= maxKey ? monthHref(nextKey, filters, currentMonthKey) : null,
  };
}

function CalendarUnavailableNotice() {
  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col px-5 py-16 sm:px-8 sm:py-24">
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>지금은 캘린더를 표시할 수 없어요.</EmptyTitle>
          <EmptyDescription>
            이 달의 공고가 너무 많아 일시적으로 일정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <a className={cn(buttonVariants({ variant: "outline", size: "sm" }))} href="/calendar">
            다시 시도
          </a>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function monthHref(
  key: string,
  filters: PublicCalendarFilters,
  currentMonthKey: string,
): string {
  const query = serializePublicCalendarQuery(key, filters, { currentMonthKey });
  return query ? `/calendar?${query}` : "/calendar";
}

// "YYYY-MM" 키에 개월을 더한다. zero-pad 문자열이라 사전식 경계 비교가 성립한다.
function shiftMonthKey(key: string, amount: number): string {
  const parsed = parseMonthKey(key);
  if (!parsed) return key;
  const zeroBased = parsed.year * 12 + (parsed.month - 1) + amount;
  const year = Math.floor(zeroBased / 12);
  const monthOfYear = (zeroBased % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(monthOfYear).padStart(2, "0")}`;
}
