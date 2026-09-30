export interface WritingConsistencyEntry { fieldId: string | null; label: string; value: string }
export interface WritingConsistencyIssue {
  kind: "project_name" | "conflicting_value" | "budget_total" | "date_order";
  message: string;
  entries: WritingConsistencyEntry[];
}
export interface WritingConsistencyReport { issues: WritingConsistencyIssue[]; checkedSections: number; recognizedValues: number }
interface Section { fieldId: string; label: string; text: string }
interface Value extends WritingConsistencyEntry { key: string; canonical: string; amount: bigint | null; group: string; metric: string }

/** 명시적인 '항목: 값'만 대조한다. 자유 문장의 수치가 같은 의미라고 추측하거나 수정하지 않는다. */
export function checkWritingConsistency(input: { projectName: string; budget: string; sections: readonly Section[] }): WritingConsistencyReport {
  const issues: WritingConsistencyIssue[] = [];
  const values: Value[] = [];
  const blocks = [{ fieldId: null, label: "이번 사업 설명 · 예산", text: input.budget }, ...input.sections];
  const projectName = normalize(input.projectName);
  for (const block of blocks) {
    const local: Value[] = [];
    for (const line of block.text.split(/\r?\n/u)) {
      const match = /^\s*(?:[-*•]\s*)?(.{1,40}?)\s*[:：]\s*(.{1,160})\s*$/u.exec(line);
      if (!match) continue;
      const key = normalize(match[1]!);
      const value = match[2]!.trim();
      const entry = { fieldId: block.fieldId, label: `${block.label} · ${match[1]!.trim()}`, value };
      if (key === "사업명" || key === "과제명") {
        if (projectName && normalize(value) !== projectName) issues.push({ kind: "project_name", message: "이번 사업 설명과 다른 사업명이 있어요. 같은 사업을 가리키는지 확인해 주세요.",
          entries: [{ fieldId: null, label: "이번 사업 이름", value: input.projectName }, entry] });
        continue;
      }
      if (key === "사업기간") {
        const period = /^(\d{4}-\d{2}-\d{2})\s*[~∼～]\s*(\d{4}-\d{2}-\d{2})$/u.exec(value);
        if (period && validDate(period[1]!) && validDate(period[2]!) && period[1]! > period[2]!) issues.push({ kind: "date_order", message: "사업 시작일이 종료일보다 늦어요.", entries: [entry] });
        continue;
      }
      // 연도와 목표/실적 표기는 key에 보존한다. 기준이 다른 매출을 모순이라고 하지 않는다.
      const metric = /^(?:(\d{4}년))?(목표|실적)?(매출|매출액|직원수|임직원수|고용인원|총사업비|정부지원금|자부담|자기부담금)$/u.exec(key);
      if (!metric) continue;
      const quantity = parseQuantity(value);
      if (!quantity) continue;
      const metricName = metric[3] === "매출" ? "매출액" : metric[3] === "자기부담금" ? "자부담" : metric[3]!;
      const group = `${metric[1] ?? ""}:${metric[2] ?? ""}`;
      const parsed: Value = { ...entry, key: `${group}:${metricName}`, group, metric: metricName, canonical: quantity.canonical, amount: quantity.won };
      values.push(parsed); local.push(parsed);
    }
    // 같은 문안/같은 연도에 세 항목이 각각 정확히 한 번 주어진 때만 합산한다.
    for (const group of new Set(local.map(value => value.group))) {
      const selected = ["총사업비", "정부지원금", "자부담"].map(metric => local.filter(value => value.group === group && value.metric === metric));
      if (!selected.every(items => items.length === 1 && items[0]!.amount !== null)) continue;
      const [total, support, own] = selected.map(items => items[0]!);
      if (total!.amount !== support!.amount! + own!.amount!) issues.push({ kind: "budget_total", message: "총사업비와 정부지원금·자부담의 합계가 달라요. 다른 재원이 있는지도 확인해 주세요.", entries: [total!, support!, own!].map(publicEntry) });
    }
  }
  for (const key of new Set(values.map(value => value.key))) {
    const entries = values.filter(value => value.key === key);
    if (new Set(entries.map(entry => entry.canonical)).size > 1) issues.push({ kind: "conflicting_value",
      message: "같은 기준으로 적힌 항목의 값이 달라요. 연도·실적·목표가 다른 값인지 확인해 주세요.", entries: entries.map(publicEntry) });
  }
  return { issues, checkedSections: input.sections.filter(section => section.text.trim()).length, recognizedValues: values.length };
}
function publicEntry({ fieldId, label, value }: WritingConsistencyEntry): WritingConsistencyEntry { return { fieldId, label, value }; }
function normalize(value: string) { return value.normalize("NFKC").replace(/\s/gu, ""); }
function validDate(value: string) { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function parseQuantity(value: string): { canonical: string; won: bigint | null } | null {
  const match = /^(\d+(?:,\d{3})*(?:\.\d+)?)\s*(천만|백만|십만|억|만|천|백)?\s*(원|명|개|곳|건|%)$/u.exec(value.trim());
  if (!match) return null;
  const [integer, fraction = ""] = match[1]!.replaceAll(",", "").split(".");
  if (fraction.length > 4 || integer!.length > 15) return null;
  const scale = 10n ** BigInt(fraction.length);
  const units: Record<string, bigint> = { "": 1n, "백": 100n, "천": 1000n, "만": 10000n, "십만": 100000n, "백만": 1000000n, "천만": 10000000n, "억": 100000000n };
  const amount = BigInt(`${integer}${fraction}`) * units[match[2] ?? ""]!;
  if (amount % scale !== 0n) return null;
  const whole = amount / scale;
  return { canonical: `${whole}${match[3]}`, won: match[3] === "원" ? whole : null };
}
