import { getDatabase } from "@/server/db";
import { requireSession } from "../../_auth";

export const runtime = "nodejs";

interface RequestRow {
  id: string;
  endpoint: string;
  model: string | null;
  status: number | null;
  outcome: string | null;
  ok: number | null;
  stream: number | null;
  api_key_prefix: string | null;
  account_id: string | null;
  account_name: string | null;
  attempt_count: number;
  started_at: string;
  completed_at: string | null;
  latency_ms: number | null;
  local_prep_ms: number | null;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  text_tokens: number | null;
  image_tokens: number | null;
  audio_tokens: number | null;
  client: string | null;
  user_agent: string | null;
  origin: string | null;
  error: string | null;
  request_size_bytes: number | null;
  response_size_bytes: number | null;
}

interface BodyRow {
  request_body_json: string | null;
  response_body_json: string | null;
  request_headers_json: string | null;
  request_truncated: number | null;
  response_truncated: number | null;
  has_request: number | null;
  has_response: number | null;
}

interface AttemptRow {
  id: string;
  account_id: string | null;
  account_name: string | null;
  attempt_number: number;
  status: number | null;
  decision: string | null;
  error_type: string | null;
  error_message: string | null;
  latency_ms: number | null;
  started_at: string;
  completed_at: string | null;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T } catch { return undefined }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = requireSession(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const db = getDatabase();
  const row = db.prepare("SELECT id,endpoint,model,status,outcome,ok,stream,api_key_prefix,account_id,account_name,attempt_count,started_at,completed_at,latency_ms,local_prep_ms,first_token_ms,prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,text_tokens,image_tokens,audio_tokens,client,user_agent,origin,error,request_size_bytes,response_size_bytes FROM gateway_requests WHERE id=? AND owner_user_id=?").get(id, user.id) as RequestRow | undefined;
  if (!row) return Response.json({ error: { type: "not_found", message: "请求不存在" } }, { status: 404 });
  const body = db.prepare("SELECT request_body_json,response_body_json,request_headers_json,request_truncated,response_truncated,has_request,has_response FROM request_bodies WHERE request_id=?").get(id) as BodyRow | undefined;
  const attempts = db.prepare("SELECT id,account_id,account_name,attempt_number,status,decision,error_type,error_message,latency_ms,started_at,completed_at FROM gateway_attempts WHERE request_id=? ORDER BY attempt_number").all(id) as AttemptRow[];
  const headers = parseJson<Record<string, string>>(body?.request_headers_json ?? null);
  return Response.json({
    request: {
      id: row.id,
      endpoint: row.endpoint,
      createdAt: row.started_at,
      model: row.model,
      stream: Boolean(row.stream),
      status: row.status,
      outcome: row.outcome,
      ok: row.ok === 1,
      apiKeyPrefix: row.api_key_prefix,
      accountId: row.account_id,
      accountName: row.account_name,
      attemptCount: row.attempt_count,
      latencyMs: row.latency_ms,
      firstTokenMs: row.first_token_ms,
      promptTokens: row.prompt_tokens,
      inputTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      outputTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      cachedTokens: row.cached_tokens,
      reasoningTokens: row.reasoning_tokens,
      textTokens: row.text_tokens,
      imageTokens: row.image_tokens,
      audioTokens: row.audio_tokens,
      hasRequest: body?.has_request === 1,
      hasResponse: body?.has_response === 1,
      client: row.client,
      userAgent: row.user_agent,
      error: row.error,
      localPrepMs: row.local_prep_ms,
      requestSizeBytes: row.request_size_bytes,
      responseSizeBytes: row.response_size_bytes,
      request: parseJson(body?.request_body_json ?? null),
      requestTruncated: body?.request_truncated === 1,
      response: parseJson(body?.response_body_json ?? null),
      responseTruncated: body?.response_truncated === 1,
      headers,
    },
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      accountId: attempt.account_id,
      accountName: attempt.account_name,
      status: attempt.status,
      decision: attempt.decision ?? undefined,
      errorType: attempt.error_type,
      errorMessage: attempt.error_message,
      latencyMs: attempt.latency_ms,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    })),
  });
}
