import { Sparkles } from "lucide-react";

export function AiEnhancementStatus({ id }: { id: string }) {
  return (
    <div
      id={id}
      className="ai-enhancement-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="ai-enhancement-status__scan" aria-hidden />
      <span className="ai-enhancement-status__icon-frame" aria-hidden>
        <span className="ai-enhancement-status__icon-glow" />
        <Sparkles className="ai-enhancement-status__icon" />
      </span>
      <span className="ai-enhancement-status__copy">
        <span className="ai-enhancement-status__eyebrow">
          AI 보강 중
          <span className="ai-enhancement-status__dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </span>
        <span className="ai-enhancement-status__title">입력한 사실을 읽고 문장을 다듬고 있어요</span>
        <span className="ai-enhancement-status__description">공고 기준에 맞춰 구조와 표현을 정리하는 중입니다.</span>
      </span>
    </div>
  );
}
