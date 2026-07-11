/**
 * registry(공개명단 배치) 소싱 공용 타입 — registry_index 테이블과 정합.
 *
 * registry 는 라이브 API 가 아니라 오프라인 배치로 적재한 registry_index 테이블을
 * 조회하는 소싱이다(CODEF 커넥터가 enrichmentCache 를 읽는 것과 동형). 이 파일은
 * 적재/조회 양 계층이 공유하는 순수 타입만 정의한다(DB·네트워크 의존 없음).
 *
 * DB 스키마(apps/web .../db/schema.ts registryIndex)와 컬럼이 일대일 대응한다.
 * id·createdAt 은 DB 생성이라 RegistryRecord 에서 제외한다.
 */

/** 적재 대상 명단의 종류. certification=인증/자격, sanction=제재, investment=투자. */
export type RegistryType = "certification" | "sanction" | "investment";

/**
 * 부재(명단에 없음)의 해석 극성.
 * - known_on_absence: 소진적 명단이라 "부재 = 해당 없음"을 확신할 수 있다(예: 부정당 제재).
 * - present_only: 존재만 근거가 되고 부재는 무정보다(예: 특정 인증 보유).
 */
export type RegistryPolarity = "known_on_absence" | "present_only";

/** registry_index 적재 대상 1행(id·createdAt 제외 = DB 생성). */
export interface RegistryRecord {
  registryType: RegistryType;
  flagOrCert: string;            // 예: "participation_restricted"
  polarity: RegistryPolarity;
  bizNo: string | null;          // 숫자만(10자리) 또는 null
  corpNo: string | null;         // 숫자만(13자리) 또는 null
  nameNormalized: string;
  representative: string | null;
  regionSido: string | null;
  validFrom: Date | null;
  validUntil: Date | null;
  detail: Record<string, unknown> | null;
  source: string;                // 데이터셋 식별자, 예 "data.go.kr:15137996"
  sourceFetchedAt: Date;
  confidence: number;
}

/** CSV 텍스트 → RegistryRecord[] 로 정규화하는 오프라인 어댑터 계약. */
export interface RegistryAdapter {
  readonly source: string;
  readonly registryType: RegistryType;
  /** 디코딩된 CSV 텍스트 → RegistryRecord[]. 순수(네트워크/DB 없음). */
  parse(csvText: string, opts?: { fetchedAt?: Date }): RegistryRecord[];
}

/** registry 조회 요청. 사업자번호/법인번호 정확 매칭 우선, 상호 퍼지 폴백. */
export interface RegistryQuery {
  bizNo?: string | null;
  corpNo?: string | null;
  name?: string | null;
  representative?: string | null;
  regionSido?: string | null;
  now?: Date;                    // 활성창 판정 기준(기본 new Date())
}

/** 매칭이 성립한 방법. */
export type RegistryMatchMethod = "exact_biz_no" | "exact_corp_no" | "fuzzy_name";

/** registry 조회 결과 1건. */
export interface RegistryMatch {
  record: RegistryRecord;
  method: RegistryMatchMethod;
  score: number;                 // exact=1, fuzzy=0..1
  active: boolean;               // validUntil == null || validUntil >= now
}
