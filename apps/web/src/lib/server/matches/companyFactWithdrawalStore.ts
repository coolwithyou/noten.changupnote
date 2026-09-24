import { eq } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  COMPANY_FACT_REUSE_CONTRACT_VERSION,
  type CompanyFactAnswerCandidate,
  type CompanyFactReuseIdentity,
} from "./companyFactReuse";

/** 질문/criterion/current source와 join하지 않는다. 철회 자체의 의미는 바뀌지 않는다. */
export async function loadCompanyFactWithdrawals(
  db: CunoteDbSession,
  companyId: string,
): Promise<CompanyFactAnswerCandidate[]> {
  const rows = await db.select().from(schema.companyFactWithdrawals)
    .where(eq(schema.companyFactWithdrawals.companyId, companyId));
  return rows.map((row) => ({
    questionId: row.sourceQuestionId,
    grantId: row.sourceGrantId,
    identity: {
      contractVersion: COMPANY_FACT_REUSE_CONTRACT_VERSION,
      conditionKey: row.conditionKey,
      semanticSha256: row.semanticSha256,
    },
    evaluation: "withdrawn",
    answerRevision: row.answerRevision,
    answeredAt: row.withdrawnAt,
  }));
}

/** 호출자는 회사 행 잠금·권한·질문 결속·답변 CAS를 검증한 같은 transaction을 전달한다. */
export async function saveCompanyFactWithdrawal(input: {
  db: CunoteDbSession;
  companyId: string;
  identity: CompanyFactReuseIdentity;
  questionId: string;
  grantId: string;
  answerRevision: number;
  answeredAt: Date;
  userId: string;
}): Promise<void> {
  const row = {
    companyId: input.companyId,
    semanticSha256: input.identity.semanticSha256,
    conditionKey: input.identity.conditionKey,
    contractVersion: input.identity.contractVersion,
    sourceQuestionId: input.questionId,
    sourceGrantId: input.grantId,
    answerRevision: input.answerRevision,
    withdrawnAt: input.answeredAt,
    withdrawnBy: input.userId,
  };
  await input.db.insert(schema.companyFactWithdrawals).values(row).onConflictDoUpdate({
    target: [schema.companyFactWithdrawals.companyId, schema.companyFactWithdrawals.semanticSha256],
    set: row,
  });
}
