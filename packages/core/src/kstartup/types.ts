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
  sprv_inst?: string | null;
  supt_biz_clsfc?: string | null;
  supt_regin?: string | null;
}

export interface KStartupApiResponse {
  data: KStartupAnnouncement[];
  totalCount?: number;
  matchCount?: number;
  page?: number;
  perPage?: number;
}

export interface NormalizeKStartupOptions {
  asOf?: Date;
  collectedAt?: Date;
}
