import assert from "node:assert/strict";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import type { MatchRepository, ServiceRepositories } from "@cunote/core";
import { createDrizzleRepositories } from "../repositories/drizzle";
import * as schema from "../db/schema";
import { refreshMatchStates } from "./matchStateRefresh";
import { submitGrantConfirmations } from "./grantConfirmations";
import { runGrantRevisionScopedRefresh } from "./grantRevisionScopedRefreshCore";

/** 전용 Unix-socket PostgreSQL에서만 실행하는 shared match_state stale-write 통합검사. */
export async function verifyMatchStateInputRevisionPostgres(input: {
  admin: postgres.Sql;
  client: postgres.Sql;
  companyId: string;
  userId: string;
}) {
  const db = drizzle(input.admin, { schema });
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grantId = crypto.randomUUID();
  const sourceId = `match-revision-${grantId}`;
  const criterionId = crypto.randomUUID();
  const questionId = crypto.randomUUID();
  await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${sourceId},'match revision fixture','open',1)`;
  await input.admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${sourceId},'{}','[]',${"1".repeat(64)},'normalized')`;
  await input.admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,needs_review)
    values (${criterionId},${grantId},'other','text_only','{"note":"자가 확인"}','exclusion',1,'해당 기업 제외',false)`;
  await input.admin`insert into grant_confirmation_questions
    (id,grant_id,grant_criteria_id,prompt,options,answer_type,reusable,prompt_ver,provenance)
    values (${questionId},${grantId},${criterionId},'제외 대상인가요?',
      '[{"value":"yes","label":"예","disqualifies":true},{"value":"no","label":"아니오","disqualifies":false}]',
      'single','per_notice','legacy-fixture','{}')`;
  await input.admin`insert into company_grant_confirmations
    (company_id,grant_id,question_id,answer,disqualified,answered_by)
    values (${input.companyId},${grantId},${questionId},'{"values":["no"]}',false,${input.userId})`;

  const grant = normalizedGrant({ grantId, sourceId, criterionId });
  const profile: CompanyProfile = {};
  const [bindingA] = await repositories.matches.captureMatchStateInputBindings({
    companyIds: [input.companyId],
    grantIds: [grantId],
  });
  assert.ok(bindingA);
  const saveReached = deferred<void>();
  const releaseOldSave = deferred<void>();
  const delayedMatches = {
    listCriterionConfirmations: repositories.matches.listCriterionConfirmations!.bind(repositories.matches),
    async saveMatchState(saveInput: Parameters<MatchRepository<unknown>["saveMatchState"]>[0]) {
      saveReached.resolve();
      await releaseOldSave.promise;
      return repositories.matches.saveMatchState(saveInput);
    },
  } as unknown as MatchRepository<unknown>;
  const refreshA = refreshMatchStates({
    repositories: { ...repositories, matches: delayedMatches } as ServiceRepositories<unknown>,
    companyId: input.companyId,
    company: profile,
    grants: [grant],
    asOf: new Date("2026-09-07T00:00:01.000Z"),
    write: true,
    inputBindings: [bindingA],
  });
  await saveReached.promise;

  // A가 계산을 끝낸 뒤 B 답변을 commit하고 같은 실제 refresh(write:true)가 최신 결과를 저장한다.
  await input.admin`update company_grant_confirmations
    set answer='{"values":["yes"]}',disqualified=true,answered_at=now()
    where company_id=${input.companyId} and question_id=${questionId}`;
  const [bindingB] = await repositories.matches.captureMatchStateInputBindings({
    companyIds: [input.companyId],
    grantIds: [grantId],
  });
  assert.ok(bindingB);
  const refreshB = await refreshMatchStates({
    repositories,
    companyId: input.companyId,
    company: profile,
    grants: [grant],
    asOf: new Date("2026-09-07T00:00:02.000Z"),
    write: true,
    inputBindings: [bindingB],
  });
  assert.equal(refreshB.savedCount, 1);
  assert.equal(refreshB.plan.states[0]?.match.eligibility, "ineligible");
  releaseOldSave.resolve();
  const staleA = await refreshA;
  assert.equal(staleA.savedCount, 0);
  assert.equal(staleA.staleCount, 1);
  const [latest] = await input.admin`select eligibility,calculation_as_of from match_state
    where company_id=${input.companyId} and grant_id=${grantId}`;
  assert.equal(latest!.eligibility, "ineligible");
  assert.equal(new Date(latest!.calculation_as_of).toISOString(), "2026-09-07T00:00:02.000Z");

  // 실제 PUT 저장→기본 재계산 코어는 최신 답변을 읽되 owned user overlay를 shared state에 쓰지 않는다.
  const submitted = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["no"] }],
    asOf: new Date("2026-09-07T00:00:03.000Z"),
  }, {
    db,
    recalculation: {
      repositories,
      resolveProfile: async () => ({ profile, stateScope: "user" }),
      annotateCards: async (cards) => cards,
    },
  });
  assert.equal(submitted.saved[0]?.disqualified, false);
  assert.equal(submitted.match?.eligibility, "eligible");
  assert.equal(submitted.refresh.status, "not_persisted_user_scope");
  assert.equal((await input.admin`select eligibility from match_state
    where company_id=${input.companyId} and grant_id=${grantId}`)[0]?.eligibility, "ineligible");

  // 답변 commit 뒤 재계산이 실패해도 PUT receipt는 저장 성공이고 stale 카드는 반환하지 않는다.
  const committedWithoutRefresh = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["yes"] }],
    asOf: new Date("2026-09-07T00:00:04.000Z"),
  }, {
    db,
    recalculate: async () => { throw new Error("fixture recalculation failure"); },
  });
  assert.equal(committedWithoutRefresh.saved[0]?.disqualified, true);
  assert.equal(committedWithoutRefresh.match, null);
  assert.equal(committedWithoutRefresh.refresh.status, "failed");
  assert.equal((await input.admin`select disqualified from company_grant_confirmations
    where company_id=${input.companyId} and question_id=${questionId}`)[0]?.disqualified, true);

  // 같은 revision에서 최초 insert가 경합해도 더 최신 asOf가 최종 상태를 소유한다.
  await input.admin`delete from match_state where company_id=${input.companyId} and grant_id=${grantId}`;
  const currentBinding = (await repositories.matches.captureMatchStateInputBindings({
    companyIds: [input.companyId], grantIds: [grantId],
  }))[0]!;
  const eligibleMatch = staleA.plan.states[0]!.match;
  const ineligibleMatch = refreshB.plan.states[0]!.match;
  const concurrent = await Promise.all([
    repositories.matches.saveMatchState({
      companyId: input.companyId, grantId, match: eligibleMatch, inputBinding: currentBinding,
      calculationAsOf: new Date("2026-09-07T00:00:09.000Z"),
    }),
    repositories.matches.saveMatchState({
      companyId: input.companyId, grantId, match: ineligibleMatch, inputBinding: currentBinding,
      calculationAsOf: new Date("2026-09-07T00:00:10.000Z"),
    }),
  ]);
  assert.ok(concurrent.some((result) => result.status === "saved"));
  const [concurrentLatest] = await input.admin`select eligibility,calculation_as_of from match_state
    where company_id=${input.companyId} and grant_id=${grantId}`;
  assert.equal(concurrentLatest!.eligibility, "ineligible");
  assert.equal(new Date(concurrentLatest!.calculation_as_of).toISOString(), "2026-09-07T00:00:10.000Z");
  assert.equal((await repositories.matches.saveMatchState({
    companyId: input.companyId, grantId, match: eligibleMatch, inputBinding: currentBinding,
    calculationAsOf: new Date("2026-09-07T00:00:08.000Z"),
  })).status, "stale_as_of");

  const protectedBeforeLegacy = await matchStateFingerprint(input.admin, input.companyId, grantId);
  await assert.rejects(
    () => exactLegacyMatchStateUpsert(input.admin, input.companyId, grantId),
    /match_state write requires match-state-input-v1 writer contract/,
  );
  await assert.rejects(
    () => input.admin.begin(async (tx) => {
      await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
      await tx`update match_state
        set input_binding=input_binding || '{"unsealed":true}'::jsonb
        where company_id=${input.companyId} and grant_id=${grantId}`;
    }),
    /match_state write requires a valid v1 input binding and calculation_as_of/,
  );
  await assert.rejects(
    () => input.admin.begin(async (tx) => {
      await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
      await tx`update match_state
        set input_binding=jsonb_set(
          input_binding,
          '{companyRevision}',
          to_jsonb((input_binding ->> 'companyRevision')::bigint)
        )
        where company_id=${input.companyId} and grant_id=${grantId}`;
    }),
    /match_state write requires a valid v1 input binding and calculation_as_of/,
  );
  await assert.rejects(
    () => input.admin.begin(async (tx) => {
      await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
      await tx`update match_state
        set input_binding=jsonb_set(
          input_binding,
          '{grantComponentRevisions,0,revision}',
          to_jsonb((input_binding #>> '{grantComponentRevisions,0,revision}')::bigint)
        )
        where company_id=${input.companyId} and grant_id=${grantId}`;
    }),
    /match_state write requires a valid v1 input binding and calculation_as_of/,
  );
  assert.deepEqual(
    await matchStateFingerprint(input.admin, input.companyId, grantId),
    protectedBeforeLegacy,
    "writer marker does not admit an unsealed binding",
  );
  assert.deepEqual(
    await matchStateFingerprint(input.admin, input.companyId, grantId),
    protectedBeforeLegacy,
    "44fda4d exact old upsert cannot preserve new metadata while replacing result fields",
  );
  await assert.rejects(
    () => input.admin`update match_state set eligibility='eligible' where company_id=${input.companyId} and grant_id=${grantId}`,
    /match_state write requires match-state-input-v1 writer contract/,
  );
  assert.deepEqual(await matchStateFingerprint(input.admin, input.companyId, grantId), protectedBeforeLegacy);

  // admin(max:1)의 같은 physical session에서 new writer transaction이 끝난 뒤에도 local marker가 새지 않는다.
  await input.admin.begin(async (tx) => {
    await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
  });
  await assert.rejects(
    () => exactLegacyMatchStateUpsert(input.admin, input.companyId, grantId),
    /match_state write requires match-state-input-v1 writer contract/,
  );

  const dueAt = new Date("2026-09-07T00:00:20.000Z");
  assert.equal((await repositories.matches.saveMatchState({
    companyId: input.companyId,
    grantId,
    match: ineligibleMatch,
    inputBinding: currentBinding,
    calculationAsOf: new Date("2026-09-07T00:00:11.000Z"),
    eligibleFrom: new Date("2026-09-07T00:00:12.000Z"),
  })).status, "saved");
  await input.admin.unsafe("alter table match_state disable trigger enforce_match_state_writer_contract");
  try {
    await input.admin`update match_state
      set input_binding=jsonb_set(
        input_binding,
        '{companyRevision}',
        to_jsonb((input_binding ->> 'companyRevision')::bigint)
      )
      where company_id=${input.companyId} and grant_id=${grantId}`;
  } finally {
    await input.admin.unsafe("alter table match_state enable trigger enforce_match_state_writer_contract");
  }
  assert.equal(
    (await repositories.matches.listDueMatchTransitions({ asOf: dueAt, limit: 500 }))
      .some((candidate) => candidate.companyId === input.companyId && candidate.grantId === grantId),
    false,
    "JSON-number company revision cannot masquerade as the current string revision",
  );
  assert.equal((await repositories.matches.saveMatchState({
    companyId: input.companyId,
    grantId,
    match: ineligibleMatch,
    inputBinding: currentBinding,
    calculationAsOf: new Date("2026-09-07T00:00:12.000Z"),
    eligibleFrom: new Date("2026-09-07T00:00:12.000Z"),
  })).status, "saved");
  await input.admin.unsafe("alter table match_state disable trigger enforce_match_state_writer_contract");
  try {
    await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
      select gen_random_uuid(),'bizinfo',${`legacy-cache-${grantId}-`} || sequence::text,
        'legacy cache fixture','open',1
      from generate_series(1,500) sequence`;
    await input.admin`insert into match_state
      (company_id,grant_id,eligibility,match_score,fit_score,rule_trace,match_confidence,
        eligible_from,ruleset_ver,scoring_ver,updated_at)
      select ${input.companyId},id,'ineligible',1,1,'[]',0.1,'2026-09-07T00:00:01.000Z',
        'ruleset-kstartup-spine-v8','scoring-verification-v3','2026-09-07T00:00:01.000Z'
      from grants where source_id like ${`legacy-cache-${grantId}-%`}`;
  } finally {
    await input.admin.unsafe("alter table match_state enable trigger enforce_match_state_writer_contract");
  }
  assert.equal(
    (await repositories.matches.listDueMatchTransitions({ asOf: dueAt, limit: 500 }))
      .some((candidate) => candidate.companyId === input.companyId && candidate.grantId === grantId),
    true,
    "500 earlier legacy rows cannot starve the current bound transition candidate",
  );
  await input.admin`delete from grants where source_id like ${`legacy-cache-${grantId}-%`}`;
  await input.admin`update companies set name=name where id=${input.companyId}`;
  assert.equal(
    (await repositories.matches.listDueMatchTransitions({ asOf: dueAt, limit: 500 }))
      .some((candidate) => candidate.companyId === input.companyId && candidate.grantId === grantId),
    false,
    "stale company revision cache is ignored",
  );
  const memberGrantId = crypto.randomUUID();
  await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${memberGrantId},'bizinfo',${`match-member-${memberGrantId}`},'match component fixture','open',1)`;
  await input.admin`insert into dedup_links(canonical_grant_id,member_grant_id,score,confirmed)
    values (${grantId},${memberGrantId},1,true)`;
  const [componentBinding] = await repositories.matches.captureMatchStateInputBindings({
    companyIds: [input.companyId],
    grantIds: [grantId],
  });
  assert.equal(componentBinding?.grantComponentRevisions.length, 2);
  assert.equal((await repositories.matches.saveMatchState({
    companyId: input.companyId,
    grantId,
    match: ineligibleMatch,
    inputBinding: componentBinding!,
    calculationAsOf: new Date("2026-09-07T00:00:21.000Z"),
    eligibleFrom: new Date("2026-09-07T00:00:12.000Z"),
  })).status, "saved");
  assert.equal(
    (await repositories.matches.listDueMatchTransitions({ asOf: dueAt, limit: 500 }))
      .some((candidate) => candidate.companyId === input.companyId && candidate.grantId === grantId),
    true,
    "current confirmed component topology is accepted",
  );
  await input.admin`delete from dedup_links where canonical_grant_id=${grantId} and member_grant_id=${memberGrantId}`;
  assert.equal(
    (await repositories.matches.listDueMatchTransitions({ asOf: dueAt, limit: 500 }))
      .some((candidate) => candidate.companyId === input.companyId && candidate.grantId === grantId),
    false,
    "confirmed component topology drift is ignored",
  );
  await input.admin`delete from grants where id=${memberGrantId}`;
  const missingBaselineRefresh = await runGrantRevisionScopedRefresh({
    db,
    grantIds: [grantId],
    companyIds: [input.companyId],
    companyLimit: 1,
    asOf: dueAt,
    write: false,
  });
  assert.equal(missingBaselineRefresh.plannedStateCount, 1);
  assert.equal(missingBaselineRefresh.changedCount, 1, "invalid cache is a missing baseline and remains recomputable");

  // 일반 제품 role은 revision 원장을 직접 고치거나 SECURITY DEFINER mutator를 호출할 수 없다.
  await input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${input.userId},true)`;
    assert.equal((await tx`update match_company_input_revisions set revision=1 where company_id=${input.companyId} returning company_id`).length, 0);
    assert.equal((await tx`delete from match_grant_input_revisions where grant_id=${grantId} returning grant_id`).length, 0);
  });
  await assert.rejects(
    () => input.client`select app_private.bump_match_grant_input_revision(${grantId}::uuid)`,
    /permission denied/,
  );

  await assertTriggerCoverage(input.admin);
  console.log("PASS: match_state current writer CAS, 0083 old-writer fence, marker isolation, cache validity, transition fairness, and RLS boundaries");
}

async function exactLegacyMatchStateUpsert(
  admin: postgres.Sql,
  companyId: string,
  grantId: string,
) {
  return admin`insert into match_state
    (company_id,grant_id,eligibility,match_score,fit_score,competitiveness,value_score,rule_trace,
      match_confidence,eligible_from,eligible_until,ruleset_ver,scoring_ver,updated_at)
    values (${companyId},${grantId},'eligible',10,10,null,null,'[]',0.1,null,null,
      'ruleset-kstartup-spine-v8','scoring-verification-v3','2026-09-07T00:00:30.000Z')
    on conflict (company_id,grant_id) do update set
      eligibility=excluded.eligibility,
      match_score=excluded.match_score,
      fit_score=excluded.fit_score,
      competitiveness=excluded.competitiveness,
      value_score=excluded.value_score,
      rule_trace=excluded.rule_trace,
      match_confidence=excluded.match_confidence,
      eligible_from=excluded.eligible_from,
      eligible_until=excluded.eligible_until,
      ruleset_ver=excluded.ruleset_ver,
      scoring_ver=excluded.scoring_ver,
      updated_at=excluded.updated_at`;
}

async function matchStateFingerprint(admin: postgres.Sql, companyId: string, grantId: string) {
  const [row] = await admin`select eligibility,match_score,fit_score,rule_trace,ruleset_ver,scoring_ver,
    input_binding,calculation_as_of,updated_at from match_state
    where company_id=${companyId} and grant_id=${grantId}`;
  assert.ok(row);
  return JSON.parse(JSON.stringify(row));
}

async function assertTriggerCoverage(admin: postgres.Sql) {
  const grantA = crypto.randomUUID();
  const grantB = crypto.randomUUID();
  const criterionId = crypto.randomUUID();
  await admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantA},'bizinfo',${grantA},'old target','open',1),(${grantB},'bizinfo',${grantB},'new target','open',1)`;
  await admin`insert into grant_criteria(id,grant_id,dimension,operator,value,kind,confidence)
    values (${criterionId},${grantA},'other','text_only','{}','required',1)`;
  const [oldBefore] = await admin`select revision from match_grant_input_revisions where grant_id=${grantA}`;
  await admin`update grant_criteria set grant_id=${grantB} where id=${criterionId}`;
  const [oldAfter] = await admin`select revision from match_grant_input_revisions where grant_id=${grantA}`;
  assert.ok(BigInt(oldAfter!.revision) > BigInt(oldBefore!.revision));

  const surfaceId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  await admin`insert into grant_application_surfaces(id,grant_id,source,source_id,type,title,format)
    values (${surfaceId},${grantB},'bizinfo',${grantB},'file_template','fixture','hwpx')`;
  await admin`insert into document_artifacts(id,surface_id,kind,storage_key,sha256)
    values (${artifactId},${surfaceId},'markdown','fixture.md',${"a".repeat(64)})`;
  const [markdownBefore] = await admin`select revision from match_grant_input_revisions where grant_id=${grantB}`;
  await admin`update document_artifacts set sha256=${"b".repeat(64)} where id=${artifactId}`;
  const [markdownAfter] = await admin`select revision from match_grant_input_revisions where grant_id=${grantB}`;
  assert.ok(BigInt(markdownAfter!.revision) > BigInt(markdownBefore!.revision));

  const cascadeCompanyId = crypto.randomUUID();
  await admin`insert into companies(id,kind,name) values (${cascadeCompanyId},'preliminary','cascade fixture')`;
  await admin`insert into company_profiles(company_id,dimension,value,source,confidence,as_of)
    values (${cascadeCompanyId},'employees','{}','self_declared',1,now())`;
  await admin`delete from companies where id=${cascadeCompanyId}`;
  assert.equal((await admin`select company_id from match_company_input_revisions where company_id=${cascadeCompanyId}`).length, 0);
  await admin`delete from grants where id in (${grantA},${grantB})`;
  assert.equal((await admin`select grant_id from match_grant_input_revisions where grant_id in (${grantA},${grantB})`).length, 0);
}

function normalizedGrant(input: {
  grantId: string;
  sourceId: string;
  criterionId: string;
}): NormalizedGrant<Record<string, never>> {
  return {
    raw: { source: "bizinfo", source_id: input.sourceId, payload: {}, status: "normalized" },
    grant: {
      id: input.grantId,
      source: "bizinfo",
      source_id: input.sourceId,
      title: "match revision fixture",
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [{
      id: input.criterionId,
      grant_id: input.grantId,
      dimension: "other",
      operator: "text_only",
      value: { note: "자가 확인" },
      kind: "exclusion",
      confidence: 1,
      source_span: "해당 기업 제외",
      needs_review: false,
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
