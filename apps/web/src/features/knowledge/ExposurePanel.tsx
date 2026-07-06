import { Eye, EyeOff, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  DeadKnowledgeLesson,
  LessonExposureMetric,
} from "@/lib/server/knowledge/knowledgeDashboardData";

interface ExposurePanelProps {
  lessonExposure: LessonExposureMetric[];
  deadKnowledge: DeadKnowledgeLesson[];
}

// target 코드 → 한국어 라벨(자립 — 병렬 세션 소유의 knowledgeLabels.ts 를 참조하지 않는다).
const TARGET_LABEL: Record<string, string> = {
  classification: "분류",
  criteria: "자격·전제",
  field_interpretation: "필드 해석",
  fill_value: "기입값·한도",
  guide: "작성 지침",
  evaluation: "심사 관점",
};

// scope 축 코드 → 라벨(죽은 지식 칩용, 자립).
const SCOPE_AXIS_LABEL: Record<string, string> = {
  program: "프로그램",
  institution: "기관",
  formTemplateId: "서식",
  documentCategory: "문서분류",
  fieldPattern: "필드",
  condition: "조건",
};
const SCOPE_AXES = [
  "program",
  "institution",
  "formTemplateId",
  "documentCategory",
  "fieldPattern",
  "condition",
] as const;

/** YYYY-MM-DD(ISO 앞 10자). */
function fmtDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * (i) 노출 지표 — 승인 lesson 이 실제로 얼마나 노출됐는지(Step 4 효과 측정의 분모).
 * 상단은 "죽은 지식" 경보(승인 후 30일 경과 & 노출 0), 하단은 최근 30일 노출 랭킹.
 */
export function ExposurePanel({ lessonExposure, deadKnowledge }: ExposurePanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>노출 지표</CardTitle>
        <CardDescription>
          승인된 지식이 공고 상세·작성 필드에 실제로 노출된 횟수입니다(노출 1회 = 페이지 뷰 1회).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 죽은 지식 경보 */}
        <DeadKnowledgeSection items={deadKnowledge} />

        {/* 최근 30일 노출 랭킹 */}
        <ExposureRankingSection items={lessonExposure} />
      </CardContent>
    </Card>
  );
}

function DeadKnowledgeSection({ items }: { items: DeadKnowledgeLesson[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
        <Eye className="size-4 shrink-0" aria-hidden />
        죽은 지식 없음 — 승인 후 30일 지난 lesson 은 모두 최소 1회 노출됐습니다.
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-amber-500/40 bg-amber-500/5 p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        죽은 지식 {items.length}건 — 승인 후 30일 경과했지만 노출 0회
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        매칭 사전 미커버·매칭 공고 부재 등으로 아무에게도 닿지 못한 지식입니다. scope·프로그램 별칭을 점검하세요.
      </p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {items.map((lesson) => {
          const scopeEntries = SCOPE_AXES.map(
            (axis) => [axis, lesson.scope?.[axis]] as const,
          ).filter(([, value]) => typeof value === "string" && value.length > 0);
          return (
            <li
              key={lesson.id}
              className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-background/60 p-3"
            >
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                >
                  <EyeOff className="size-3" aria-hidden />
                  노출 0
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  승인 {fmtDay(lesson.approvedAt)}
                </span>
              </div>
              <p className="text-sm leading-6 text-foreground/90">{lesson.instruction}</p>
              {scopeEntries.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {scopeEntries.map(([axis, value]) => (
                    <span
                      key={axis}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                    >
                      <span className="text-muted-foreground">{SCOPE_AXIS_LABEL[axis] ?? axis}</span>
                      <span className="font-medium">{value}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExposureRankingSection({ items }: { items: LessonExposureMetric[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Eye className="size-4 shrink-0" aria-hidden />
        노출 대상(승인 lesson)이 아직 없습니다.
      </div>
    );
  }

  const totalExposure30d = items.reduce((sum, item) => sum + item.exposure30d, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">최근 30일 노출 랭킹</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          승인 {items.length}건 · 최근 30일 총 {totalExposure30d}회
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((lesson) => (
          <li
            key={lesson.id}
            className="flex items-start gap-3 rounded-[var(--radius-md)] border border-border p-3"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{TARGET_LABEL[lesson.target] ?? lesson.target}</Badge>
                {lesson.program ? (
                  <Badge variant="secondary" className="font-normal">
                    {lesson.program}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm leading-6 text-foreground/90">{lesson.instruction}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5 pl-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-sm font-semibold tabular-nums",
                  lesson.exposure30d === 0 ? "text-muted-foreground" : "text-foreground",
                )}
              >
                <Eye className="size-3.5" aria-hidden />
                {lesson.exposure30d}
              </span>
              <span className="text-[0.7rem] text-muted-foreground tabular-nums">
                전체 {lesson.exposureTotal}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
