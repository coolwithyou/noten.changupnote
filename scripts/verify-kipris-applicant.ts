/** KIPRISPlus 사업자번호 exact 커넥터 라이브 스모크. 키 값은 절대 출력하지 않는다. */
import { loadMonorepoEnv } from "../apps/web/src/lib/server/loadMonorepoEnv.js";
import { checkKiprisApplicant } from "../packages/core/src/kipris/check-applicant.js";
import { checkKiprisRights } from "../packages/core/src/kipris/check-rights.js";

loadMonorepoEnv();
const accessKey = process.env.KIPRIS_SERVICE_KEY?.trim();
console.log(`KIPRIS_SERVICE_KEY: ${accessKey ? "configured" : "missing"}`);

if (accessKey) {
  const bizNo = (process.argv[2] ?? "3948603207").replace(/\D/g, "");
  const match = await checkKiprisApplicant({ accessKey, bizNo });
  const rights = match
    ? await checkKiprisRights({ accessKey, applicantNumber: match.applicantNumber })
    : null;
  console.log(JSON.stringify(
    match
      ? {
          outcome: "exact_match",
          applicantNumber: match.applicantNumber,
          businessRegistrationNumber: match.businessRegistrationNumber,
          rights,
        }
      : { outcome: "empty_public_registered_history" },
    null,
    2,
  ));
}
