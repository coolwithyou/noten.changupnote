"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SectionIntro } from "./marketing-sections";

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "정말 사업자번호만 넣으면 되나요?",
    a: "네. 사업자번호로 공개된 사업자 정보를 불러와 표준화된 지원사업과 자동으로 대조해요. 추가 입력 없이 조회가 시작돼요.",
  },
  {
    q: "회원가입을 꼭 해야 하나요?",
    a: "조회는 회원가입 없이 가능해요. 결과를 저장하거나 신청 코칭을 받을 때부터 계정이 필요해요.",
  },
  {
    q: "어떤 지원사업을 다루나요?",
    a: "중소벤처기업부·소상공인시장진흥공단·KOTRA·한국콘텐츠진흥원 등 40여 개 기관의 공고를 매주 수집해 한 형식으로 표준화해요.",
  },
  {
    q: "조건 확인도는 어떻게 계산되나요?",
    a: "업종·업력·지역·매출 같은 회사 정보와 공고의 필수·제외조건을 대조해, 현재 확인이 끝난 조건의 비율을 보여줘요. 선정 가능성을 예측하는 점수는 아니에요.",
  },
  {
    q: "비용이 있나요?",
    a: "지원사업 조회와 매칭은 무료예요. 팀 단위 신청 관리 기능은 도입 문의를 통해 안내해 드려요.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
      <SectionIntro eyebrow="자주 묻는 질문" title="궁금한 점이 있으세요?" />
      <Accordion className="mt-10 gap-3" multiple={false} defaultValue={[0]}>
        {FAQS.map((faq, index) => (
          <AccordionItem
            key={faq.q}
            value={index}
            className="rounded-xl border bg-card px-4 shadow-[var(--shadow-subtle)]"
          >
            <AccordionTrigger className="text-base font-semibold text-foreground hover:no-underline">
              {faq.q}
            </AccordionTrigger>
            <AccordionContent className="text-[15px] leading-relaxed text-muted-foreground">
              {faq.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
