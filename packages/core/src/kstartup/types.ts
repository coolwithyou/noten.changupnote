import type { KStartupDetailContent } from "./detail.js";

export interface KStartupAnnouncement {
  aply_excl_trgt_ctnt?: string | null;
  aply_mthd_eml_rcpt_istc?: string | null;
  aply_mthd_etc_istc?: string | null;
  aply_mthd_fax_rcpt_istc?: string | null;
  aply_mthd_onli_rcpt_istc?: string | null;
  aply_mthd_pssr_rcpt_istc?: string | null;
  aply_mthd_vst_rcpt_istc?: string | null;
  aply_trgt?: string | null;
  aply_trgt_ctnt?: string | null;
  biz_enyy?: string | null;
  biz_gdnc_url?: string | null;
  biz_pbanc_nm?: string | null;
  biz_prch_dprt_nm?: string | null;
  biz_trgt_age?: string | null;
  detl_pg_url?: string | null;
  intg_pbanc_biz_nm?: string | null;
  pbanc_ctnt?: string | null;
  pbanc_ntrp_nm?: string | null;
  pbanc_rcpt_bgng_dt?: string | null;
  pbanc_rcpt_end_dt?: string | null;
  pbanc_sn: number | string;
  prfn_matr?: string | null;
  /** K-Startup API 모집진행여부. `N`이면 접수일 누락 여부와 무관하게 모집 종료다. */
  rcrt_prgs_yn?: string | null;
  sprv_inst?: string | null;
  supt_biz_clsfc?: string | null;
  supt_regin?: string | null;
  detail?: KStartupDetailContent;
}

export interface KStartupApiResponse {
  data: KStartupAnnouncement[];
  totalCount?: number;
  matchCount?: number;
  page?: number;
  perPage?: number;
  currentCount?: number;
}

export interface NormalizeKStartupOptions {
  asOf?: Date;
  collectedAt?: Date;
  /** P5 전까지 기본 false. prior_award 결정론 splitter를 명시적으로 활성화할 때만 사용한다. */
  priorAwardSplit?: boolean;
}

export interface KStartupAttachmentMarkdown {
  filename: string;
  markdown: string;
}

export interface KStartupExtractionBlock {
  label: string;
  source: "api_field" | "detail_section" | "attachment_markdown";
  source_field?: keyof KStartupAnnouncement | "detail.apply_method_text" | "detail.submit_documents_text";
  filename?: string;
  text: string;
}

export interface KStartupExtractionInput {
  source: "kstartup";
  source_id: string;
  title: string;
  category: string | null;
  blocks: KStartupExtractionBlock[];
  text: string;
}

export interface KStartupFetchPageOptions {
  serviceKey: string;
  page?: number;
  perPage?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface KStartupFetchManyOptions extends KStartupFetchPageOptions {
  pages?: number;
}
