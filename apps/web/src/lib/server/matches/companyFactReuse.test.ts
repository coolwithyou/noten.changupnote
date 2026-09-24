import assert from "node:assert/strict";
import {
  buildCompanyFactReuseIdentity,
  optionValueForEvaluation,
  resolveCompanyFactAnswer,
  type CompanyFactReuseQuestion,
} from "./companyFactReuse";

const base = (overrides: Partial<CompanyFactReuseQuestion> = {}): CompanyFactReuseQuestion => ({
  questionId: crypto.randomUUID(),
  grantId: crypto.randomUUID(),
  reusable: "company_fact",
  conditionKey: "siheung_registered_business_location",
  evaluationContractVersion: "confirmation-evaluation-v2",
  answerType: "single",
  options: [
    { value: "yes", evaluation: "satisfied" },
    { value: "no", evaluation: "unsatisfied" },
    { value: "unknown", evaluation: "unknown" },
  ],
  criterion: {
    dimension: "region",
    kind: "required",
    operator: "in",
    value: {
      codes: ["41390"],
      facility_scope: ["headquarters", "branch", "factory"],
      basis_date: "2026-09-22",
    },
  },
  ...overrides,
});

const fourSameFacts = Array.from({ length: 4 }, () => base());
const identities = fourSameFacts.map(buildCompanyFactReuseIdentity);
assert.ok(identities.every(Boolean));
assert.equal(new Set(identities.map((identity) => identity!.semanticSha256)).size, 1);

const headquartersOnly = buildCompanyFactReuseIdentity(base({
  criterion: {
    ...base().criterion,
    value: {
      codes: ["41390"],
      facility_scope: ["headquarters"],
      basis_date: "2026-09-22",
    },
  },
}));
assert.notEqual(headquartersOnly?.semanticSha256, identities[0]?.semanticSha256);

const differentBasisDate = buildCompanyFactReuseIdentity(base({
  criterion: {
    ...base().criterion,
    value: {
      codes: ["41390"],
      facility_scope: ["headquarters", "branch", "factory"],
      basis_date: "2026-10-01",
    },
  },
}));
assert.notEqual(differentBasisDate?.semanticSha256, identities[0]?.semanticSha256);

const differentMeaning = buildCompanyFactReuseIdentity(base({
  conditionKey: "siheung_registered_headquarters_ownership",
}));
assert.notEqual(differentMeaning?.conditionKey, identities[0]?.conditionKey);
assert.equal(resolveCompanyFactAnswer({ identity: differentMeaning!, candidates: [{
  questionId: fourSameFacts[0]!.questionId,
  grantId: fourSameFacts[0]!.grantId,
  identity: identities[0]!,
  evaluation: "satisfied",
  answerRevision: 1,
  answeredAt: new Date("2026-09-22T00:00:00.000Z"),
}] }), null);

assert.equal(buildCompanyFactReuseIdentity(base({ conditionKey: "Siheung location" })), null);
assert.equal(buildCompanyFactReuseIdentity(base({ reusable: "per_notice" })), null);
assert.equal(buildCompanyFactReuseIdentity(base({
  options: [
    { value: "yes", evaluation: "satisfied" },
    { value: "no", evaluation: "unsatisfied" },
  ],
})), null);

const identity = identities[0]!;
const older = {
  questionId: fourSameFacts[0]!.questionId,
  grantId: fourSameFacts[0]!.grantId,
  identity,
  evaluation: "unsatisfied" as const,
  answerRevision: 1,
  answeredAt: new Date("2026-09-22T01:00:00.000Z"),
};
const newest = {
  questionId: fourSameFacts[1]!.questionId,
  grantId: fourSameFacts[1]!.grantId,
  identity,
  evaluation: "satisfied" as const,
  answerRevision: 1,
  answeredAt: new Date("2026-09-22T02:00:00.000Z"),
};
const resolved = resolveCompanyFactAnswer({ identity, candidates: [older, newest] });
assert.equal(resolved?.evaluation, "satisfied");
assert.equal(resolved?.sourceGrantId, newest.grantId);
assert.match(resolved?.companyFactRevision ?? "", /^[0-9a-f]{64}$/);
assert.equal(optionValueForEvaluation(fourSameFacts[2]!, resolved!.evaluation), "yes");

assert.equal(resolveCompanyFactAnswer({
  identity,
  candidates: [
    newest,
    {
      ...newest,
      questionId: fourSameFacts[2]!.questionId,
      evaluation: "withdrawn",
      answeredAt: new Date("2026-09-22T03:00:00.000Z"),
    },
  ],
}), null, "철회 tombstone은 과거 답변이 다시 나타나지 않게 한다");

assert.equal(resolveCompanyFactAnswer({
  identity,
  candidates: [
    newest,
    {
      ...newest,
      questionId: fourSameFacts[2]!.questionId,
      evaluation: "unsatisfied",
      answerRevision: 2,
    },
  ],
}), null, "같은 시각·revision의 상충 답변은 임의 선택하지 않는다");

console.log("PASS: company fact reuse identity separates scope/date and resolves only an unambiguous latest answer");
