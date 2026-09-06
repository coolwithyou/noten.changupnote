"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "사업자번호를 넣은 뒤 무엇을 하나요?",
    a: "기본정보 조회 후 소재지·업종 등 매칭에 필요한 정보를 확인하고 보완해요. 자동조회값과 직접 입력한 값을 구분하며, 모르는 항목은 미확인으로 남길 수 있어요. 입력 완료가 지원 자격 확정을 뜻하지는 않아요.",
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
    q: "지원서 작성과 제출도 자동으로 되나요?",
    a: "아니요. 양식과 기능의 준비 상태에 따라 편집·작성 제안을 도와드려요. 제안은 직접 검토하고 선택해 반영하며, 서명·증빙 확인과 최종 제출은 직접 진행해야 해요.",
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
