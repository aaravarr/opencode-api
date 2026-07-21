export const MAX_CAPTURE_BYTES = 1_048_576;
const MAX_BODY_ERROR_CHARS = 500;
const PREVIEW_CHARS = 8000;

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  textTokens?: number;
  imageTokens?: number;
  audioTokens?: number;
  reasoningTokens?: number;
}

export interface CaptureResult {
  response?: unknown;
  responseTruncated?: boolean;
  responseBytes?: number;
  usage?: TokenUsage;
  firstByteAt?: number;
  error?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageObject(usage: Record<string, unknown>): TokenUsage | undefined {
  const promptTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const totalTokens = num(usage.total_tokens);
  const cachedTokens = num(usage.cached_tokens) ?? num(usage.cache_read_input_tokens);
  const reasoningTokens = num(usage.reasoning_tokens) ?? num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  const textTokens = num(usage.text_tokens) ?? num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.text_tokens);
  const imageTokens = num(usage.image_tokens);
  const audioTokens = num(usage.audio_tokens);
  const computed = totalTokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const any = promptTokens ?? completionTokens ?? totalTokens ?? cachedTokens ?? reasoningTokens ?? textTokens ?? imageTokens ?? audioTokens;
  if (any === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: computed,
    cachedTokens,
    textTokens,
    imageTokens,
    audioTokens,
    reasoningTokens,
  };
}

export function extractUsage(payload: unknown): TokenUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const usageRaw = root.usage ?? (root.message as Record<string, unknown> | undefined)?.usage;
  if (usageRaw && typeof usageRaw === "object") {
    const parsed = readUsageObject(usageRaw as Record<string, unknown>);
    if (parsed) return parsed;
  }
  return undefined;
}

export function extractUsageFromSse(text: string): TokenUsage | undefined {
  let last: TokenUsage | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      const usage = extractUsage(parsed);
      if (usage) last = usage;
    } catch {
      // ignore malformed lines
    }
  }
  return last;
}

export function extractBodyError(payload: unknown): string | undefined {
  const stack: unknown[] = [payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value) continue;
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= MAX_BODY_ERROR_CHARS * 2) return value.slice(0, MAX_BODY_ERROR_CHARS);
      continue;
    }
    if (typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "error" || key === "message" || key === "detail" || key === "reason") {
        if (typeof child === "string") return child.slice(0, MAX_BODY_ERROR_CHARS);
        if (child && typeof child === "object") {
          const inner = (child as Record<string, unknown>).message;
          if (typeof inner === "string") return inner.slice(0, MAX_BODY_ERROR_CHARS);
        }
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return undefined;
}

export function isLogOk(status: number, bodyError?: string | null): boolean {
  if (status >= 200 && status < 400) return bodyError ? false : true;
  return false;
}

export function safeCloneBody(body: unknown, maxBytes = MAX_CAPTURE_BYTES): { value: unknown; truncated: boolean } {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= maxBytes) return { value: body, truncated: false };
  return {
    value: { _truncated: true, _originalBytes: text.length, preview: text.slice(0, PREVIEW_CHARS) },
    truncated: true,
  };
}

export function ensureStreamUsage(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = { ...(body as Record<string, unknown>) };
  if (clone.stream !== true) return clone;
  const streamOptions = { ...((clone.stream_options as Record<string, unknown> | undefined) ?? {}) };
  streamOptions.include_usage = true;
  clone.stream_options = streamOptions;
  return clone;
}

export function teeAndCapture(
  stream: ReadableStream<Uint8Array>,
  onComplete: (r: CaptureResult) => void,
): ReadableStream<Uint8Array> {
  const [client, side] = stream.tee();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let firstByteAt: number | undefined;
  let truncated = false;
  (async () => {
    const reader = side.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (firstByteAt === undefined) firstByteAt = Date.now();
        if (total < MAX_CAPTURE_BYTES) {
          chunks.push(result.value);
          total += result.value.byteLength;
          if (total > MAX_CAPTURE_BYTES) truncated = true;
        } else {
          truncated = true;
        }
      }
    } catch {
      // ignore capture errors
    } finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }
    const text = decoder.decode(chunks.length ? concatBytes(chunks) : new Uint8Array(), { stream: false });
    let usage = extractUsageFromSse(text);
    let response: unknown;
    if (!usage) {
      try { response = JSON.parse(text); usage = extractUsage(response) } catch { /* keep text */ }
    } else {
      try { response = JSON.parse(text) } catch { /* keep text */ }
    }
    const error = extractBodyError(usage ? undefined : tryParseText(text));
    onComplete({ response: truncated ? undefined : response, responseTruncated: truncated, responseBytes: total, usage, firstByteAt, error });
  })();
  return client;
}

export function captureJsonResponse(
  stream: ReadableStream<Uint8Array>,
  onComplete: (r: CaptureResult) => void,
): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let firstByteAt: number | undefined;
  let truncated = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (firstByteAt === undefined) firstByteAt = Date.now();
          controller.enqueue(result.value);
          if (total < MAX_CAPTURE_BYTES) {
            chunks.push(result.value);
            total += result.value.byteLength;
            if (total > MAX_CAPTURE_BYTES) truncated = true;
          } else {
            truncated = true;
          }
        }
        controller.close();
      } catch (cause) {
        controller.error(cause);
        return;
      } finally {
        try { reader.releaseLock() } catch { /* noop */ }
      }
      const text = new TextDecoder().decode(chunks.length ? concatBytes(chunks) : new Uint8Array());
      let response: unknown;
      try { response = JSON.parse(text) } catch { /* keep text */ }
      const usage = extractUsage(response);
      const error = extractBodyError(response) ?? (usage ? undefined : extractBodyError(tryParseText(text)));
      onComplete({ response: truncated ? undefined : response, responseTruncated: truncated, responseBytes: total, usage, firstByteAt, error });
    },
    async cancel(reason) {
      try { await stream.cancel(reason) } catch { /* noop */ }
    },
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out;
}

function tryParseText(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text) } catch { return text.length > MAX_BODY_ERROR_CHARS * 2 ? undefined : { error: text } }
}
