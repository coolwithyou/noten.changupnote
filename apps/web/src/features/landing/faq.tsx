"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

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
    a: "중소벤처기업부·소상공인시장진흥공단·KOTRA·한국콘텐츠진흥원 등 여러 기관의 공고를 수집해 한 형식으로 표준화해요.",
  },
  {
    q: "비용이 있나요?",
    a: "공고를 찾고 확인하는 건 무료예요. 실시간 알림과 신청서 작성 도우미는 이용 전에 별도로 안내해 드려요.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[720px] px-4 pb-14 sm:px-10">
      <Accordion className="border-y border-border-subtle" multiple={false}>
        {FAQS.map((faq, index) => (
          <AccordionItem
            key={faq.q}
            value={String(index)}
            className="border-border-subtle px-1"
          >
            <AccordionTrigger className="py-[19px] text-base font-semibold text-ink hover:no-underline">
              {faq.q}
            </AccordionTrigger>
            <AccordionContent className="pr-8 pb-[19px] text-[15px] leading-relaxed text-text-secondary">
              {faq.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
