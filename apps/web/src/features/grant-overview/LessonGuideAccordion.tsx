import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { GrantLessonGuide } from "@/features/knowledge/GrantLessonGuide";
import type { GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";

/**
 * 아코디언 ③ 작성 유의사항 (계획 §4.2, §8 P1-2).
 * `GrantLessonGuide`(지식 루프 Step 3 소비처)를 그대로 이관해 접힌 아코디언 안에 넣는다.
 * 컴포넌트 자체는 수정하지 않는다(파일 스코프 — features/knowledge 는 읽기 전용).
 * guide 가 없거나 매칭된 lesson 이 없으면 아코디언 항목 자체를 렌더하지 않는다.
 */
export function LessonGuideAccordion({ guide }: { guide: GrantLessonGuideDto | null }) {
  if (!guide?.matched || guide.total === 0) return null;

  return (
    <AccordionItem value="lessons">
      <AccordionTrigger>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span>작성 유의사항</span>
          <span className="text-xs font-normal text-muted-foreground">
            유의사항 {guide.total.toLocaleString("ko-KR")}건
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <GrantLessonGuide guide={guide} />
      </AccordionContent>
    </AccordionItem>
  );
}
