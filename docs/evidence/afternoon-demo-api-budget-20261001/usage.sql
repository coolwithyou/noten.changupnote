-- Read-only. Change start timestamp to the recorded API-demo baseline.
-- No message contents, keys, or credentials are selected.
WITH request_usage AS (
  SELECT 'chat'::text AS source_kind, m.id AS request_id, s.id AS session_id,
    s.model, m.created_at, CASE WHEN m.usage IS NULL THEN 'unavailable' ELSE 'reported' END AS usage_status,
    (m.usage->>'input')::bigint AS input_tokens,
    (m.usage->>'output')::bigint AS output_tokens,
    (m.usage->>'cacheRead')::bigint AS cache_read_tokens,
    (m.usage->>'cacheWrite')::bigint AS cache_write_tokens
  FROM chat_messages m JOIN chat_sessions s ON s.id=m.session_id
  WHERE s.company_id='a0132dd3-9cb7-87a1-95ef-6cfc171a795f'
    AND s.user_id='f212886d-bb64-4fcf-aab5-43114ebc9e63'
    AND m.role='assistant' AND m.created_at >= '2026-10-01T00:00:00Z'
  UNION ALL
  SELECT e.source_kind, e.source_request_id, NULL::uuid, e.model, e.created_at,
    e.usage_status, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens
  FROM generative_usage_events e
  WHERE e.company_id='a0132dd3-9cb7-87a1-95ef-6cfc171a795f'
    AND e.user_id='f212886d-bb64-4fcf-aab5-43114ebc9e63'
    AND e.created_at >= '2026-10-01T00:00:00Z'
), rated AS (
  SELECT *, CASE
    WHEN model='claude-haiku-4-5-20251001' THEN
      (input_tokens*1.0+output_tokens*5.0+cache_read_tokens*0.1+cache_write_tokens*1.25)/1000000
    WHEN model='claude-sonnet-4-6' THEN
      (input_tokens*3.0+output_tokens*15.0+cache_read_tokens*0.3+cache_write_tokens*3.75)/1000000
    ELSE NULL END AS estimated_usd
  FROM request_usage
)
SELECT *, sum(estimated_usd) OVER (ORDER BY created_at, request_id) AS cumulative_reported_usd
FROM rated ORDER BY created_at, request_id;
