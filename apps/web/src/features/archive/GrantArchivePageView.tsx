import { Archive, CalendarDays, ExternalLink, FileText, GanttChartSquare, RotateCcw, Search } from "lucide-react";
import type { CriterionDimension } from "@cunote/contracts";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { ServiceHeader } from "@/components/app/service-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { HeaderUser } from "@/lib/server/auth/session";
import { cn } from "@/lib/utils";
import { ArchiveSaveButton } from "./ArchiveSaveButton";
import {
  benefitFamilyLabel,
  criterionDimensionLabel,
  type GrantArchiveFacetOption,
  type GrantArchiveFacets,
  type GrantArchiveItem,
  type GrantArchiveQuery,
  type GrantArchiveResult,
  type GrantArchiveView,
} from "@/lib/server/archive/grantArchiveSearch";

interface GrantArchivePageViewProps {
  archive: GrantArchiveResult;
  currentParams: URLSearchParams;
  facets: GrantArchiveFacets;
  query: GrantArchiveQuery;
  queryError: string | null;
  user: HeaderUser | null;
}

const SOURCE_OPTIONS = [
  { value: "kstartup", label: "K-Startup" },
  { value: "bizinfo", label: "기업마당" },
  { value: "bizinfo_event", label: "기업마당 행사" },
] as const;

const STATUS_OPTIONS = [
  { value: "open", label: "접수 중" },
  { value: "upcoming", label: "예정" },
  { value: "closed", label: "마감" },
  { value: "unknown", label: "확인 필요" },
] as const;

const BENEFIT_OPTIONS = [
  "funding",
  "loan",
  "capability",
  "space",
  "market",
  "certification",
  "network",
] as const;

const CRITERION_OPTIONS = [
  { value: "region", label: criterionDimensionLabel("region"), placeholder: "서울, 전국" },
  { value: "biz_age", label: criterionDimensionLabel("biz_age"), placeholder: "7년, 예비" },
  { value: "industry", label: criterionDimensionLabel("industry"), placeholder: "소프트웨어" },
  { value: "size", label: criterionDimensionLabel("size"), placeholder: "중소기업, 소상공인" },
  { value: "revenue", label: criterionDimensionLabel("revenue"), placeholder: "10억, 매출" },
  { value: "employees", label: criterionDimensionLabel("employees"), placeholder: "5인, 근로자" },
  { value: "founder_age", label: criterionDimensionLabel("founder_age"), placeholder: "39세, 중장년" },
  { value: "founder_trait", label: criterionDimensionLabel("founder_trait"), placeholder: "여성, 청년" },
  { value: "certification", label: criterionDimensionLabel("certification"), placeholder: "벤처기업" },
  { value: "prior_award", label: criterionDimensionLabel("prior_award"), placeholder: "기수혜, 수상" },
  { value: "ip", label: criterionDimensionLabel("ip"), placeholder: "특허, 상표" },
  { value: "target_type", label: criterionDimensionLabel("target_type"), placeholder: "청년, 소상공인" },
  { value: "business_status", label: criterionDimensionLabel("business_status"), placeholder: "예비창업, 폐업" },
  { value: "other", label: criterionDimensionLabel("other"), placeholder: "TRL, 컨소시엄" },
] as const;

const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"] as const;
const DAY_MS = 86_400_000;

export function GrantArchivePageView({
  archive,
  currentParams,
  facets,
  query,
  queryError,
  user,
}: GrantArchivePageViewProps) {
  const view = query.view ?? "list";
  const stats = archiveStats(archive.items, archive.total);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/archive" })} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="grid gap-4 rounded-[var(--radius-xl)] border bg-card p-6 shadow-[var(--shadow-subtle)] lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end" aria-labelledby="archive-title">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">지원사업 아카이브</p>
          <h1 id="archive-title" className="mt-2 text-2xl font-semibold tracking-normal sm:text-3xl">전체 공고를 조건과 혜택으로 탐색하세요</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">정기 수집된 공고를 출처, 기간, 7개 혜택, 14개 신청 조건 축으로 검색합니다.</p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end" aria-label="아카이브 보기 전환">
          <a className={viewLinkClass(view, "list")} href={viewHref(currentParams, "list")}>
            <Archive data-icon="inline-start" />
            목록
          </a>
          <a className={viewLinkClass(view, "calendar")} href={viewHref(currentParams, "calendar")}>
            <CalendarDays data-icon="inline-start" />
            캘린더
          </a>
          <a className={viewLinkClass(view, "gantt")} href={viewHref(currentParams, "gantt")}>
            <GanttChartSquare data-icon="inline-start" />
            간트
          </a>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="아카이브 결과 요약">
        <Metric label="검색 결과" value={`${stats.total.toLocaleString("ko-KR")}건`} />
        <Metric label="표시 중 접수" value={`${stats.open.toLocaleString("ko-KR")}건`} />
        <Metric label="마감 7일" value={`${stats.deadlineSoon.toLocaleString("ko-KR")}건`} />
        <Metric label="검수 필요" value={`${stats.needsReview.toLocaleString("ko-KR")}건`} />
        <Metric label="첨부 보관" value={`${stats.attachments.toLocaleString("ko-KR")}건`} />
      </section>

      {queryError ? <p className="rounded-[var(--radius-xl)] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{queryError}</p> : null}

      <section className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ArchiveFilterPanel currentParams={currentParams} facets={facets} query={query} />
        <Card>
          <CardHeader className="lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <CardDescription>{archive.total.toLocaleString("ko-KR")}건 중 {archive.items.length.toLocaleString("ko-KR")}건 표시</CardDescription>
              <CardTitle className="mt-1 text-lg">{viewTitle(view)}</CardTitle>
            </div>
            <CardDescription>생성 {formatDateTime(archive.generatedAt)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {view === "calendar" ? <ArchiveCalendarPreview items={archive.items} /> : null}
            {view === "gantt" ? <ArchiveGanttPreview items={archive.items} /> : null}
            {view === "list" ? <GrantArchiveTable items={archive.items} /> : null}
            <ArchivePagination archive={archive} currentParams={currentParams} />
          </CardContent>
        </Card>
      </section>
      </div>
    </main>
  );
}

function ArchiveFilterPanel({
  currentParams,
  facets,
  query,
}: {
  currentParams: URLSearchParams;
  facets: GrantArchiveFacets;
  query: GrantArchiveQuery;
}) {
  return (
    <aside className="self-start rounded-[var(--radius-xl)] border bg-card p-4 shadow-[var(--shadow-subtle)]" aria-label="아카이브 필터">
      <form action="/archive" method="get" className="grid gap-5">
        <input type="hidden" name="view" value={query.view ?? "list"} />
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="archive-q">검색</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input className="h-10 w-full rounded-[var(--radius-lg)] border bg-input py-2 pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15" id="archive-q" name="q" type="search" defaultValue={query.q ?? ""} placeholder="공고명, 기관명" />
          </div>
        </div>

        <div className="grid gap-2">
          <strong className="text-sm font-medium">출처</strong>
          {SOURCE_OPTIONS.map((option) => (
            <label className="flex items-center gap-2 text-sm" key={option.value}>
              <input className="size-4 rounded border-input accent-primary" type="checkbox" name="source" value={option.value} defaultChecked={query.sources?.includes(option.value)} />
              <FilterOptionText label={option.label} count={facetCount(facets.sources, option.value)} />
            </label>
          ))}
        </div>

        <div className="grid gap-2">
          <strong className="text-sm font-medium">상태</strong>
          {STATUS_OPTIONS.map((option) => (
            <label className="flex items-center gap-2 text-sm" key={option.value}>
              <input className="size-4 rounded border-input accent-primary" type="checkbox" name="status" value={option.value} defaultChecked={query.statuses?.includes(option.value)} />
              <FilterOptionText label={option.label} count={facetCount(facets.statuses, option.value)} />
            </label>
          ))}
        </div>

        <div className="grid gap-2">
          <strong className="text-sm font-medium">지원 혜택</strong>
          {BENEFIT_OPTIONS.map((family) => (
            <label className="flex items-center gap-2 text-sm" key={family}>
              <input className="size-4 rounded border-input accent-primary" type="checkbox" name="benefit" value={family} defaultChecked={query.benefitFamilies?.includes(family)} />
              <FilterOptionText label={benefitFamilyLabel(family)} count={facetCount(facets.benefits, family)} />
            </label>
          ))}
        </div>

        <FacetCheckboxGroup
          title="기관/분야"
          groups={[
            {
              label: "지역/부처",
              name: "agencyJurisdiction",
              options: facets.agencyJurisdictions,
              selected: query.agencyJurisdictions,
            },
            {
              label: "수행기관",
              name: "agencyOperator",
              options: facets.agencyOperators,
              selected: query.agencyOperators,
            },
            {
              label: "대분류",
              name: "categoryL1",
              options: facets.categoryL1,
              selected: query.categoryL1,
            },
            {
              label: "중분류",
              name: "categoryL2",
              options: facets.categoryL2,
              selected: query.categoryL2,
            },
          ]}
        />

        <div className="grid gap-3">
          <strong className="text-sm font-medium">신청 조건</strong>
          {CRITERION_OPTIONS.map((option) => (
            <label className="grid gap-1.5" key={option.value}>
              <FilterOptionText label={option.label} count={criterionFacetCount(facets, option.value)} />
              <input
                className="h-9 rounded-[var(--radius-lg)] border bg-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
                name={`criterion.${option.value}`}
                defaultValue={criterionValue(query, option.value)}
                placeholder={option.placeholder}
              />
            </label>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">마감 시작</span>
            <input className="h-9 rounded-[var(--radius-lg)] border bg-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15" type="date" name="applyEndFrom" defaultValue={dateInputValue(query.applyEndFrom)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">마감 종료</span>
            <input className="h-9 rounded-[var(--radius-lg)] border bg-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15" type="date" name="applyEndTo" defaultValue={dateInputValue(query.applyEndTo)} />
          </label>
        </div>

        <div className="grid gap-2">
          <strong className="text-sm font-medium">품질/자료</strong>
          <label className="flex items-center gap-2 text-sm">
            <input className="size-4 rounded border-input accent-primary" type="checkbox" name="hasRequiredDocuments" value="true" defaultChecked={query.hasRequiredDocuments === true} />
            <FilterOptionText label="제출서류 있음" count={facets.quality.hasRequiredDocuments} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input className="size-4 rounded border-input accent-primary" type="checkbox" name="hasArchivedAttachments" value="true" defaultChecked={query.hasArchivedAttachments === true} />
            <FilterOptionText label="첨부 보관 있음" count={facets.quality.hasArchivedAttachments} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input className="size-4 rounded border-input accent-primary" type="checkbox" name="needsReview" value="true" defaultChecked={query.needsReview === true} />
            <FilterOptionText label="검수 필요" count={facets.quality.needsReview} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input className="size-4 rounded border-input accent-primary" type="checkbox" name="textOnly" value="true" defaultChecked={query.textOnly === true} />
            <FilterOptionText label="원문 확인 조건" count={facets.quality.textOnly} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">정렬</span>
            <select className="h-9 rounded-[var(--radius-lg)] border bg-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15" name="sort" defaultValue={query.sort ?? "deadline"}>
              <option value="deadline">마감순</option>
              <option value="start_date">시작일순</option>
              <option value="title">공고명순</option>
              <option value="confidence">신뢰도순</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">표시</span>
            <select className="h-9 rounded-[var(--radius-lg)] border bg-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15" name="limit" defaultValue={String(query.limit ?? 40)}>
              <option value="20">20건</option>
              <option value="40">40건</option>
              <option value="80">80건</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className={buttonVariants({ size: "sm" })} type="submit">
            <Search data-icon="inline-start" />
            적용
          </button>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={resetHref(currentParams)}>
            <RotateCcw data-icon="inline-start" />
            초기화
          </a>
        </div>
      </form>
    </aside>
  );
}

function FacetCheckboxGroup({
  title,
  groups,
}: {
  title: string;
  groups: Array<{
    label: string;
    name: string;
    options: GrantArchiveFacetOption[];
    selected?: string[] | undefined;
  }>;
}) {
  if (groups.every((group) => group.options.length === 0)) return null;
  return (
    <div className="grid gap-3">
      <strong className="text-sm font-medium">{title}</strong>
      {groups.map((group) => (
        <div key={group.name} className="grid gap-2 rounded-[var(--radius-lg)] border bg-muted/30 p-3">
          <span className="text-xs font-medium text-muted-foreground">{group.label}</span>
          {facetFilterOptions(group.options, group.selected).map((option) => (
            <label className="flex items-center gap-2 text-sm" key={`${group.name}-${option.value}`}>
              <input
                className="size-4 rounded border-input accent-primary"
                type="checkbox"
                name={group.name}
                value={option.value}
                defaultChecked={option.selected}
              />
              <FilterOptionText label={option.label} count={option.count} />
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function facetFilterOptions(options: GrantArchiveFacetOption[], selected: string[] | undefined): GrantArchiveFacetOption[] {
  const selectedSet = new Set(selected ?? []);
  const visible = options
    .filter((option) => option.count > 0 || option.selected || selectedSet.has(option.value))
    .slice(0, 8);
  for (const value of selectedSet) {
    if (!visible.some((option) => option.value === value)) {
      visible.unshift({ value, label: value, count: 0, selected: true });
    }
  }
  return visible;
}

function FilterOptionText({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="truncate">{label}</span>
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{count.toLocaleString("ko-KR")}</span>
    </span>
  );
}

function GrantArchiveTable({ items }: { items: GrantArchiveItem[] }) {
  if (items.length === 0) {
    return (
      <Empty className="border border-border">
        <EmptyDescription>조건에 맞는 공고가 없습니다.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-xl)] border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>공고</TableHead>
            <TableHead>혜택</TableHead>
            <TableHead>신청 조건</TableHead>
            <TableHead>기간</TableHead>
            <TableHead>자료</TableHead>
            <TableHead>작업</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.grantId}>
              <TableCell className="min-w-[260px]">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Badge variant="outline">{sourceLabel(item.source)}</Badge>
                  <Badge variant={statusBadgeVariant(item.status)}>{statusLabel(item.status)}</Badge>
                  {item.applicationStage ? <Badge variant="secondary">{applicationStageLabel(item.applicationStage)}</Badge> : null}
                </div>
                <strong className="block text-sm font-semibold leading-6">{item.title}</strong>
                <span className="mt-1 block text-xs text-muted-foreground">{[item.agencyJurisdiction, item.agencyOperator].filter(Boolean).join(" · ") || "기관 확인"}</span>
              </TableCell>
              <TableCell className="min-w-[180px]">
                <div className="flex flex-wrap gap-1.5">
                {item.benefits.slice(0, 3).map((benefit) => (
                  <Badge key={`${item.grantId}-${benefit.family}`} variant="secondary">{benefitFamilyLabel(benefit.family)}</Badge>
                ))}
                </div>
                {item.supportAmountLabel ? <span className="mt-2 block text-xs text-muted-foreground">{item.supportAmountLabel}</span> : null}
              </TableCell>
              <TableCell className="min-w-[220px]">
                <div className="grid gap-1">
                {item.conditionSummary.slice(0, 4).map((condition) => (
                  <span className="text-xs text-muted-foreground" key={`${item.grantId}-${condition.dimension}`}>
                    {condition.label}: {condition.valueLabel}
                  </span>
                ))}
                </div>
              </TableCell>
              <TableCell>
                <time>{dateRangeLabel(item.applyStart, item.applyEnd)}</time>
                <span className="mt-1 block text-xs font-medium text-primary">{dDayLabel(item.dDay)}</span>
              </TableCell>
              <TableCell>
                <div className="grid gap-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><FileText className="size-3.5" aria-hidden /> 서류 {item.requiredDocumentCount}</span>
                <span>첨부 {item.archivedAttachmentCount}</span>
                {item.needsReviewCount > 0 ? <Badge variant="destructive">검수 {item.needsReviewCount}</Badge> : null}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex min-w-[220px] flex-wrap gap-2">
                  <ArchiveSaveButton grantId={item.grantId} initialStage={item.applicationStage} />
                  <a className={buttonVariants({ variant: "outline", size: "sm" })} href={item.detailHref}>상세</a>
                  <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={`${item.detailHref}#application-prep`}>지원 준비</a>
                  {item.url ? (
                    <a className={buttonVariants({ variant: "ghost", size: "sm" })} href={item.url} target="_blank" rel="noreferrer">
                      <ExternalLink data-icon="inline-start" />
                      원문
                    </a>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ArchiveCalendarPreview({ items }: { items: GrantArchiveItem[] }) {
  const calendar = buildCalendarMonth(items);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="text-base font-semibold">{calendar.monthLabel}</strong>
          <span className="mt-1 block text-sm text-muted-foreground">마감일 기준 {calendar.scheduledCount.toLocaleString("ko-KR")}건</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="캘린더 상태 범례">
          <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-primary" /> 접수 중</span>
          <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-muted-foreground" /> 예정</span>
          <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-border" /> 마감</span>
        </div>
      </div>
      {calendar.scheduledCount > 0 ? (
        <div className="grid grid-cols-7 overflow-hidden rounded-[var(--radius-xl)] border" aria-label={`${calendar.monthLabel} 마감 캘린더`}>
          {WEEKDAY_LABELS.map((weekday) => (
            <div key={weekday} className="border-b bg-muted/50 px-2 py-2 text-center text-xs font-medium text-muted-foreground">{weekday}</div>
          ))}
          {calendar.days.map((day) => (
            <div
              key={day.isoDate}
              className={cn(
                "min-h-28 border-b border-r p-2 last:border-r-0",
                !day.inMonth && "bg-muted/30 text-muted-foreground",
                day.items.length > 0 && "bg-card",
              )}
            >
              <time className="text-xs font-medium" dateTime={day.isoDate}>{day.dayOfMonth}</time>
              <div className="mt-2 grid gap-1">
                {day.items.slice(0, 3).map((item) => (
                  <a
                    key={item.grantId}
                    className={cn(
                      "block truncate rounded-md px-2 py-1 text-xs font-medium hover:underline",
                      scheduleStatusClass(item.status),
                    )}
                    href={item.detailHref}
                  >
                    <span className="mr-1 tabular-nums">{dDayLabel(item.dDay)}</span>
                    {item.title}
                  </a>
                ))}
                {day.items.length > 3 ? (
                  <span className="text-xs text-muted-foreground">+{(day.items.length - 3).toLocaleString("ko-KR")}건</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty className="border border-border">
          <EmptyDescription>마감일이 있는 공고가 없습니다.</EmptyDescription>
        </Empty>
      )}
      <ArchiveDatelessList title="마감일 확인 필요" items={calendar.datelessItems} />
    </div>
  );
}

function ArchiveGanttPreview({ items }: { items: GrantArchiveItem[] }) {
  const gantt = buildGanttModel(items);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="text-base font-semibold">{gantt.rangeLabel}</strong>
          <span className="mt-1 block text-sm text-muted-foreground">접수 기간 기준 {gantt.rows.length.toLocaleString("ko-KR")}건</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="간트 상태 범례">
          {gantt.legend.map((status) => (
            <span className="inline-flex items-center gap-1" key={status}><i className={cn("size-2 rounded-full", scheduleDotClass(status))} /> {statusLabel(status)}</span>
          ))}
        </div>
      </div>
      {gantt.rows.length > 0 ? (
        <div className="grid gap-2 overflow-x-auto rounded-[var(--radius-xl)] border p-3">
          <div className="grid min-w-[720px] grid-cols-[220px_minmax(360px,1fr)_120px] items-center gap-3 text-xs text-muted-foreground" aria-hidden>
            <span />
            <div className="grid" style={{ gridTemplateColumns: `repeat(${gantt.ticks.length}, minmax(0, 1fr))` }}>
              {gantt.ticks.map((tick) => (
                <time key={tick.isoDate} dateTime={tick.isoDate}>{tick.label}</time>
              ))}
            </div>
          </div>
          {gantt.rows.map((row) => (
            <div key={row.item.grantId} className="grid min-w-[720px] grid-cols-[220px_minmax(360px,1fr)_120px] items-center gap-3 rounded-[var(--radius-lg)] border bg-muted/30 px-3 py-2">
              <a className="truncate text-sm font-medium hover:underline" href={row.item.detailHref}>{row.item.title}</a>
              <div className="relative h-7 rounded-full bg-background">
                <span
                  className={cn("absolute top-1/2 flex h-5 -translate-y-1/2 items-center justify-center overflow-hidden rounded-full px-2 text-[11px] font-medium", scheduleStatusClass(row.item.status))}
                  style={{ left: `${row.left}%`, width: `${row.width}%` }}
                >
                  {statusLabel(row.item.status)}
                </span>
              </div>
              <time className="text-xs text-muted-foreground">{dateRangeLabel(row.item.applyStart, row.item.applyEnd)}</time>
            </div>
          ))}
        </div>
      ) : (
        <Empty className="border border-border">
          <EmptyDescription>기간을 비교할 공고가 없습니다.</EmptyDescription>
        </Empty>
      )}
      <ArchiveDatelessList title="접수 기간 확인 필요" items={gantt.datelessItems} />
    </div>
  );
}

function ArchiveDatelessList({ title, items }: { title: string; items: GrantArchiveItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-3 rounded-[var(--radius-xl)] border bg-muted/30 p-4">
      <strong className="text-sm font-semibold">{title}</strong>
      <div className="grid gap-2">
        {items.slice(0, 8).map((item) => (
          <a className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-card px-3 py-2 text-sm hover:underline" key={item.grantId} href={item.detailHref}>
            <Badge variant={statusBadgeVariant(item.status)}>{statusLabel(item.status)}</Badge>
            <span className="truncate">{item.title}</span>
          </a>
        ))}
      </div>
      {items.length > 8 ? <span className="text-xs text-muted-foreground">외 {(items.length - 8).toLocaleString("ko-KR")}건</span> : null}
    </div>
  );
}

function ArchivePagination({
  archive,
  currentParams,
}: {
  archive: GrantArchiveResult;
  currentParams: URLSearchParams;
}) {
  if (!archive.hasMore && !currentParams.get("cursor")) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <a className={buttonVariants({ variant: "outline", size: "sm" })} href={pageHref(currentParams, null)}>처음</a>
      {archive.hasMore ? (
        <a className={buttonVariants({ size: "sm" })} href={pageHref(currentParams, archive.cursor)}>다음</a>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <strong className="text-2xl font-semibold tracking-normal">{value}</strong>
      </CardContent>
    </Card>
  );
}

function archiveStats(items: GrantArchiveItem[], total: number) {
  return {
    total,
    open: items.filter((item) => item.status === "open").length,
    deadlineSoon: items.filter((item) => item.dDay !== null && item.dDay >= 0 && item.dDay <= 7).length,
    needsReview: items.filter((item) => item.needsReviewCount > 0).length,
    attachments: items.filter((item) => item.archivedAttachmentCount > 0).length,
  };
}

function criterionValue(query: GrantArchiveQuery, dimension: CriterionDimension): string {
  return query.criterionFilters?.find((filter) => filter.dimension === dimension)?.values?.join(", ") ?? "";
}

function facetCount(options: GrantArchiveFacetOption[], value: string): number {
  return options.find((option) => option.value === value)?.count ?? 0;
}

function criterionFacetCount(
  facets: GrantArchiveFacets,
  dimension: CriterionDimension,
): number {
  return facets.criteria.find((facet) => facet.dimension === dimension)?.count ?? 0;
}

function viewHref(params: URLSearchParams, view: GrantArchiveView): string {
  const next = new URLSearchParams(params);
  next.set("view", view);
  next.delete("cursor");
  return `/archive?${next.toString()}`;
}

function pageHref(params: URLSearchParams, cursor: string | null): string {
  const next = new URLSearchParams(params);
  if (cursor) next.set("cursor", cursor);
  else next.delete("cursor");
  const query = next.toString();
  return query ? `/archive?${query}` : "/archive";
}

function resetHref(params: URLSearchParams): string {
  const view = params.get("view");
  return view && view !== "list" ? `/archive?view=${encodeURIComponent(view)}` : "/archive";
}

function viewLinkClass(current: GrantArchiveView, target: GrantArchiveView): string {
  return buttonVariants({
    variant: current === target ? "secondary" : "outline",
    size: "sm",
  });
}

function viewTitle(view: GrantArchiveView): string {
  if (view === "calendar") return "마감 캘린더";
  if (view === "gantt") return "접수 기간 간트";
  return "공고 목록";
}

function buildCalendarMonth(items: GrantArchiveItem[]) {
  const datedItems = items
    .map((item) => {
      const date = parseArchiveDate(item.applyEnd);
      return date ? { item, date, isoDate: isoDate(date), monthKey: monthKey(date) } : null;
    })
    .filter((entry): entry is { item: GrantArchiveItem; date: Date; isoDate: string; monthKey: string } => Boolean(entry));
  const datelessItems = items.filter((item) => !parseArchiveDate(item.applyEnd));

  if (datedItems.length === 0) {
    return {
      monthLabel: "마감일 없음",
      scheduledCount: 0,
      days: [] as Array<{ isoDate: string; dayOfMonth: number; inMonth: boolean; items: GrantArchiveItem[] }>,
      datelessItems,
    };
  }

  const selectedMonth = mostPopulatedMonth(datedItems);
  const firstOfMonth = parseMonthKey(selectedMonth);
  const firstVisibleDay = startOfWeekMonday(firstOfMonth);
  const itemsByDay = new Map<string, GrantArchiveItem[]>();
  for (const entry of datedItems) {
    const current = itemsByDay.get(entry.isoDate) ?? [];
    current.push(entry.item);
    itemsByDay.set(entry.isoDate, current);
  }

  return {
    monthLabel: formatMonth(firstOfMonth),
    scheduledCount: datedItems.filter((entry) => entry.monthKey === selectedMonth).length,
    days: Array.from({ length: 42 }, (_, index) => {
      const date = addDays(firstVisibleDay, index);
      const key = isoDate(date);
      return {
        isoDate: key,
        dayOfMonth: date.getUTCDate(),
        inMonth: monthKey(date) === selectedMonth,
        items: sortItemsForSchedule(itemsByDay.get(key) ?? []),
      };
    }),
    datelessItems,
  };
}

function buildGanttModel(items: GrantArchiveItem[]) {
  const rows = items
    .map((item) => {
      const start = parseArchiveDate(item.applyStart);
      const end = parseArchiveDate(item.applyEnd);
      return start && end ? { item, start, end: end < start ? start : end } : null;
    })
    .filter((entry): entry is { item: GrantArchiveItem; start: Date; end: Date } => Boolean(entry))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime() || a.item.title.localeCompare(b.item.title, "ko-KR"))
    .slice(0, 40);
  const datelessItems = items.filter((item) => !parseArchiveDate(item.applyStart) || !parseArchiveDate(item.applyEnd));

  if (rows.length === 0) {
    return {
      rangeLabel: "기간 없음",
      ticks: [] as Array<{ isoDate: string; label: string }>,
      rows: [] as Array<{ item: GrantArchiveItem; left: number; width: number }>,
      legend: [] as Array<GrantArchiveItem["status"]>,
      datelessItems,
    };
  }

  const domainStart = new Date(Math.min(...rows.map((row) => row.start.getTime())));
  const domainEnd = new Date(Math.max(...rows.map((row) => row.end.getTime())));
  const domainDays = Math.max(1, daysBetween(domainStart, domainEnd));
  const ticks = buildGanttTicks(domainStart, domainEnd);

  return {
    rangeLabel: `${formatDate(isoDate(domainStart))} - ${formatDate(isoDate(domainEnd))}`,
    ticks,
    rows: rows.map((row) => {
      const left = clampPercent((daysBetween(domainStart, row.start) / domainDays) * 100);
      const width = Math.max(4, clampPercent((Math.max(1, daysBetween(row.start, row.end)) / domainDays) * 100));
      return { item: row.item, left, width: Math.min(width, 100 - left) };
    }),
    legend: [...new Set(rows.map((row) => row.item.status))],
    datelessItems,
  };
}

function mostPopulatedMonth(entries: Array<{ monthKey: string }>): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.monthKey, (counts.get(entry.monthKey) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? monthKey(new Date());
}

function sortItemsForSchedule(items: GrantArchiveItem[]): GrantArchiveItem[] {
  return [...items].sort((a, b) =>
    statusRank(a.status) - statusRank(b.status) ||
    (a.dDay ?? Number.POSITIVE_INFINITY) - (b.dDay ?? Number.POSITIVE_INFINITY) ||
    a.title.localeCompare(b.title, "ko-KR")
  );
}

function buildGanttTicks(start: Date, end: Date): Array<{ isoDate: string; label: string }> {
  const totalDays = Math.max(1, daysBetween(start, end));
  return Array.from({ length: 5 }, (_, index) => {
    const offset = Math.round((totalDays * index) / 4);
    const date = addDays(start, offset);
    return { isoDate: isoDate(date), label: formatDate(isoDate(date)) };
  });
}

function parseArchiveDate(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function parseMonthKey(value: string): Date {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return new Date(Date.UTC(year, month - 1, 1));
}

function startOfWeekMonday(value: Date): Date {
  const day = value.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(value, mondayOffset);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / DAY_MS));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function monthKey(value: Date): string {
  return value.toISOString().slice(0, 7);
}

function formatMonth(value: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", timeZone: "UTC" }).format(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function statusRank(status: GrantArchiveItem["status"]): number {
  if (status === "open") return 0;
  if (status === "upcoming") return 1;
  if (status === "unknown") return 2;
  return 3;
}

function statusLabel(status: GrantArchiveItem["status"]): string {
  if (status === "open") return "접수 중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  return "확인 필요";
}

function applicationStageLabel(stage: NonNullable<GrantArchiveItem["applicationStage"]>): string {
  if (stage === "saved") return "저장됨";
  if (stage === "preparing") return "준비 중";
  if (stage === "submitted") return "제출";
  if (stage === "selected") return "선정";
  if (stage === "rejected") return "탈락";
  if (stage === "blocked") return "막힘";
  if (stage === "dismissed") return "보류";
  return "추천";
}

function statusBadgeVariant(status: GrantArchiveItem["status"]): "default" | "secondary" | "outline" {
  if (status === "open") return "default";
  if (status === "upcoming") return "secondary";
  return "outline";
}

function scheduleStatusClass(status: GrantArchiveItem["status"]): string {
  if (status === "open") return "bg-primary text-primary-foreground";
  if (status === "upcoming") return "bg-secondary text-secondary-foreground";
  if (status === "closed") return "bg-muted text-muted-foreground";
  return "bg-card text-muted-foreground ring-1 ring-border";
}

function scheduleDotClass(status: GrantArchiveItem["status"]): string {
  if (status === "open") return "bg-primary";
  if (status === "upcoming") return "bg-secondary";
  if (status === "closed") return "bg-border";
  return "bg-muted-foreground";
}

function sourceLabel(source: GrantArchiveItem["source"]): string {
  if (source === "kstartup") return "K-Startup";
  if (source === "bizinfo") return "기업마당";
  return "기업마당 행사";
}

function dateRangeLabel(start: string | null, end: string | null): string {
  if (!start && !end) return "기간 확인";
  if (!start) return `마감 ${formatDate(end)}`;
  if (!end) return `${formatDate(start)} 시작`;
  return `${formatDate(start)} - ${formatDate(end)}`;
}

function dDayLabel(dDay: number | null): string {
  if (dDay === null) return "D-day 확인";
  if (dDay === 0) return "D-day";
  if (dDay > 0) return `D-${dDay}`;
  return `D+${Math.abs(dDay)}`;
}

function dateInputValue(value: string | undefined): string {
  return value?.slice(0, 10) ?? "";
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
