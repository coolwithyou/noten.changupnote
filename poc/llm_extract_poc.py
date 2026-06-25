#!/usr/bin/env python3
"""
S0-C: 공고 텍스트 → grant_criteria LLM 추출 PoC (tool-use 구조화 출력)
키: 환경변수 ANTHROPIC_API_KEY (커밋 금지). 입력 텍스트는 K-Startup scoped 또는 HWP 변환 md.
교훈: raw 텍스트 JSON 파싱은 불안정(1/3 실패) → tool-use로 강제하면 안정.
"""
import os, json, urllib.request

AK=os.environ["ANTHROPIC_API_KEY"]

TOOL={"name":"emit_grant_criteria","description":"공고 자격요건을 구조화 추출",
 "input_schema":{"type":"object","properties":{"criteria":{"type":"array","items":{"type":"object",
   "properties":{
     "dimension":{"type":"string","enum":["region","biz_age","industry","size","revenue","employees",
                  "founder_trait","certification","prior_award","ip","other"]},
     "operator":{"type":"string","enum":["in","not_in","lte","gte","between","exists","text_only"]},  # enum 강제(일관성)
     "value":{"type":"object"},
     "kind":{"type":"string","enum":["required","preferred","exclusion"]},
     "confidence":{"type":"number"},"source_span":{"type":"string"},"needs_review":{"type":"boolean"}},
   "required":["dimension","operator","kind","confidence","source_span","needs_review"]}}},"required":["criteria"]}}

SYS=("한국 정부 지원사업 공고에서 '자격요건'만 추출해 emit_grant_criteria 도구로 출력. "
"명시 안 된 건 날조 금지. 자동판정 불가 문구는 operator=text_only, needs_review=true. "
"지원내용/사업개요 등 자격이 아닌 정보는 제외. value는 dimension에 맞는 객체"
"(region:{regions:[]}, biz_age:{max_months:N}, size:{sizes:[]} 등).")

def extract(text, model="claude-sonnet-4-6"):
    body={"model":model,"max_tokens":2000,"system":SYS,"tools":[TOOL],
          "tool_choice":{"type":"tool","name":"emit_grant_criteria"},
          "messages":[{"role":"user","content":text}]}
    req=urllib.request.Request("https://api.anthropic.com/v1/messages",data=json.dumps(body).encode(),
        headers={"x-api-key":AK,"anthropic-version":"2023-06-01","content-type":"application/json"})
    r=json.load(urllib.request.urlopen(req,timeout=90))
    for b in r["content"]:
        if b["type"]=="tool_use": return b["input"]["criteria"], r["usage"]
    return [], r["usage"]

if __name__=="__main__":
    import sys
    text=open(sys.argv[1],encoding="utf-8").read() if len(sys.argv)>1 else "[공고명]테스트\n[신청대상]서울 소재 업력 3년 이내 중소기업"
    crit,usage=extract(text)
    print(json.dumps(crit,ensure_ascii=False,indent=2))
    print("usage:",usage)
