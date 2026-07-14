import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { GrantLessonGuide } from "@/features/knowledge/GrantLessonGuide";
import type { GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";

/**
 * 아코디언 ③ 작성 유의사항 (계획 §4.2, §8 P1-2).
 * `GrantLessonGuide`(지식 루프 Step 3 소비처)를 그대로 이관해 접힌 아코디언 안에 넣는다.
 * 컴포넌트 자체는 수정하지 않는다(파일 스코프 — features/knowledge 는 읽기 전용).
 * guide 가 없거나 매칭된 lesson 이 없어도 3개 항목 계약을 유지하고 정직한 빈 상태를 보여준다.
 */
export function LessonGuideAccordion({ guide }: { guide: GrantLessonGuideDto | null }) {
  const hasGuide = Boolean(guide?.matched && guide.total > 0);

  return (
    <AccordionItem value="lessons" className="border-b border-border-subtle">
      <AccordionTrigger className="px-1 py-[18px] text-[15.5px] font-semibold hover:no-underline">
        유의사항
      </AccordionTrigger>
      <AccordionContent className="px-1 pb-5">
        {hasGuide && guide ? (
          <>
            <p className="text-xs text-muted-foreground">
              검증된 유의사항 {guide.total.toLocaleString("ko-KR")}건
            </p>
            <GrantLessonGuide guide={guide} />
          </>
        ) : (
          <Empty className="panel-empty">
            <EmptyDescription>
              검증된 유의사항이 아직 없습니다. 공고 원문을 우선 확인해 주세요.
            </EmptyDescription>
          </Empty>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}
