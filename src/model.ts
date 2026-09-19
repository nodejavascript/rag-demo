/**
 * The model server.
 *
 * Two providers, one interface, and a deliberate default of **neither**: the URL is
 * configuration, so the same build runs against the Ollama container on a laptop and
 * against DigitalOcean's inference endpoint in production without a line changing.
 *
 *   `ollama`  — a model on the same machine. No API key, no vendor, and the reason
 *               the local build can promise that nothing is uploaded.
 *   `openai`  — anything that speaks the OpenAI HTTP shape, which includes
 *               DigitalOcean Gradient AI, DeepSeek, Groq, Together and OpenAI itself.
 *
 * 🔴 The honesty rule this file carries: **a failed request is reported as a failure
 * of the model server, in words that say what to do about it.** It is never retried
 * silently, never dressed up as an empty answer, and never replaced by a guess. A
 * reader checking an answer against a document has to be able to tell "the document
 * does not say" from "the model did not answer", because those are different facts
 * and only one of them is about the document.
 */

import { readFileSync } from 'node:fs';
import { AppError } from './types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** 0 makes the answers repeatable, which matters when the answer is a quotation. */
  temperature: number;
  numCtx: number;
  /** Hard cap on the reply, so a runaway answer cannot fill the page. */
  numPredict: number;
}

/**
 * Sampling is OFF by default, and that is a product decision rather than a default.
 *
 * This tool is asked to answer from a document and to quote it. At a temperature
 * above zero the same document and the same question give different answers on
 * different runs — a fact-finder that answers differently on a Tuesday is not a
 * fact-finder. Every reader here is checking an answer against a page they can read,
 * so variation they cannot reproduce reads as the tool being wrong rather than as it
 * being unsure. The cost is that the writing is a little plainer. That is the right
 * trade, and `TEMPERATURE` can raise it if George ever wants the words instead.
 */
export const DEFAULT_CHAT_OPTIONS: ChatOptions = { temperature: 0, numCtx: 8192, numPredict: 700 };

export interface ModelConfig {
  provider: 'ollama' | 'openai';
  baseUrl: string;
  apiKey: string | null;
  chatModel: string;
  embedModel: string;
  rerankModel: string | null;
  /** How many vectors one embedding request may carry. */
  embedBatch: number;
}

/**
 * The key, from the environment it was ASKED ABOUT.
 *
 * 🔴 `env` is a parameter, not the global. It was read from `process.env` directly until a
 * test built a configuration from a supplied environment and the key quietly came from
 * somewhere else — a function that accepts an environment has to honour it, or the
 * parameter is a decoration and the only way to test the key path is to mutate the
 * process. Found by `test/model.test.js`.
 */
function readKey(env: NodeJS.ProcessEnv): string | null {
  const inline = env.MODEL_API_KEY?.trim();
  if (inline) return inline;
  const file = env.MODEL_API_KEY_FILE?.trim();
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Work out which provider to talk to.
 *
 * An explicit `MODEL_BASE_URL` always wins. Otherwise: an Ollama on localhost if one
 * is configured, and the DigitalOcean endpoint when `DO_INFERENCE=1`. There is no
 * silent fallback between the two — a request that goes to the wrong provider is a
 * privacy failure, not a convenience.
 */
export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const explicit = env.MODEL_BASE_URL?.trim();
  const provider = (env.MODEL_PROVIDER?.trim() as 'ollama' | 'openai' | undefined)
    ?? (explicit && /ollama|11434/.test(explicit) ? 'ollama' : explicit ? 'openai' : 'ollama');

  if (provider === 'ollama') {
    return {
      provider,
      baseUrl: (explicit ?? env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
      apiKey: null,
      chatModel: env.CHAT_MODEL?.trim() || 'qwen2.5:7b',
      embedModel: env.EMBED_MODEL?.trim() || 'nomic-embed-text',
      rerankModel: env.RERANK_MODEL?.trim() || null,
      embedBatch: 16,
    };
  }

  return {
    provider,
    baseUrl: (explicit ?? 'https://inference.do-ai.run/v1').replace(/\/$/, ''),
    apiKey: readKey(env),
    chatModel: env.CHAT_MODEL?.trim() || 'openai-gpt-oss-20b',
    embedModel: env.EMBED_MODEL?.trim() || 'bge-m3',
    rerankModel: env.RERANK_MODEL?.trim() || null,
    embedBatch: 64,
  };
}

/** Unit length, so a cosine is just a dot product and a scan is cheap. */
export function normalise(vector: Float64Array): Float64Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
  const length = Math.sqrt(sum);
  if (length === 0 || !Number.isFinite(length)) return vector;
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] as number) / length;
  return out;
}

export class Model {
  readonly config: ModelConfig;
  /** Set once a rerank has failed, so it is not attempted again in the same run. */
  #rerankBroken = false;

  constructor(config: ModelConfig = modelConfig()) {
    this.config = config;
  }

  get rerankAvailable(): boolean {
    return this.config.rerankModel !== null && !this.#rerankBroken;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  async #request<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AppError(
        `The model server at ${this.config.baseUrl} ${timedOut ? 'timed out' : 'is not answering'}.` +
          (this.config.provider === 'ollama'
            ? ' Start it with: docker compose up -d ollama'
            : ' Check MODEL_BASE_URL and the network.'),
        503
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const hint =
        response.status === 402
          ? ' On DigitalOcean this means serverless inference is not enabled on the account yet.'
          : response.status === 401 || response.status === 403
            ? ' The API key was refused. Check MODEL_API_KEY_FILE.'
            : '';
      throw new AppError(
        `The model provider refused the request (${response.status}).${hint} ${detail.slice(0, 200)}`,
        response.status === 402 ? 402 : 502
      );
    }

    return (await response.json()) as T;
  }

  /** Embed a batch, normalised. A batch of zero is a batch of zero, not an error. */
  async embed(inputs: string[]): Promise<Float64Array[]> {
    if (inputs.length === 0) return [];
    const out: Float64Array[] = [];
    for (let i = 0; i < inputs.length; i += this.config.embedBatch) {
      const slice = inputs.slice(i, i + this.config.embedBatch);
      out.push(...(await this.#embedBatch(slice)));
    }
    return out;
  }

  async #embedBatch(inputs: string[]): Promise<Float64Array[]> {
    if (this.config.provider === 'ollama') {
      const body = await this.#request<{ embeddings?: number[][] }>(
        '/api/embed',
        { model: this.config.embedModel, input: inputs },
        180_000
      );
      const vectors = body.embeddings ?? [];
      if (vectors.length !== inputs.length) {
        throw new AppError(
          `The model server returned ${vectors.length} vectors for ${inputs.length} passages. ` +
            `Is "${this.config.embedModel}" installed? Run: ollama pull ${this.config.embedModel}`,
          502
        );
      }
      return vectors.map((vector) => normalise(Float64Array.from(vector)));
    }

    const body = await this.#request<{ data?: { embedding?: number[]; index?: number }[] }>(
      '/embeddings',
      { model: this.config.embedModel, input: inputs },
      180_000
    );
    const rows = body.data ?? [];
    if (rows.length !== inputs.length) {
      throw new AppError(
        `The model provider returned ${rows.length} vectors for ${inputs.length} passages ` +
          `from "${this.config.embedModel}".`,
        502
      );
    }
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((row) => normalise(Float64Array.from(row.embedding ?? [])));
  }

  /** One complete answer, not a stream. */
  async chat(messages: ChatMessage[], options: ChatOptions = DEFAULT_CHAT_OPTIONS): Promise<string> {
    if (this.config.provider === 'ollama') {
      const body = await this.#request<{ message?: { content?: string } }>(
        '/api/chat',
        {
          model: this.config.chatModel,
          stream: false,
          messages,
          options: {
            temperature: options.temperature,
            num_ctx: options.numCtx,
            num_predict: options.numPredict,
          },
        },
        180_000
      );
      const content = body.message?.content?.trim();
      if (!content) throw new AppError('The model server returned an empty reply.', 502);
      return content;
    }

    const body = await this.#request<{ choices?: { message?: { content?: string } }[] }>(
      '/chat/completions',
      {
        model: this.config.chatModel,
        temperature: options.temperature,
        max_tokens: options.numPredict,
        messages,
      },
      180_000
    );
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new AppError('The model provider returned an empty reply.', 502);
    return content;
  }

  /**
   * Score notes against a question with a cross-encoder, or return null.
   *
   * A reranker is a real improvement — it is the one component that reads the
   * question and the note together — and it is entirely optional. If the model is
   * not configured, or the provider has no rerank route, the run continues on the
   * fused ranking alone and says so in `warnings`. It never blocks an answer.
   */
  async rerank(question: string, documents: string[]): Promise<number[] | null> {
    if (!this.rerankAvailable || documents.length === 0) return null;
    const model = this.config.rerankModel as string;
    try {
      const body = await this.#request<{ results?: { index?: number; relevance_score?: number }[] }>(
        '/rerank',
        { model, query: question, documents, top_n: documents.length },
        60_000
      );
      const rows = body.results ?? [];
      if (rows.length === 0) throw new Error('no results');
      const scores = new Array<number>(documents.length).fill(0);
      for (const row of rows) {
        const at = row.index ?? -1;
        if (at >= 0 && at < documents.length) scores[at] = row.relevance_score ?? 0;
      }
      return scores;
    } catch {
      this.#rerankBroken = true;
      return null;
    }
  }

  /** Whether the provider is up, in words the page can show. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      if (this.config.provider === 'ollama') {
        const response = await fetch(`${this.config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) return { ok: false, detail: `Ollama answered ${response.status}` };
        const body = (await response.json()) as { models?: { name: string }[] };
        const names = (body.models ?? []).map((m) => m.name);
        const missing = [this.config.embedModel, this.config.chatModel].filter(
          (model) => !names.some((name) => name === model || name.startsWith(`${model}:`))
        );
        if (missing.length > 0) return { ok: false, detail: `Not pulled: ${missing.join(', ')}` };
        return { ok: true, detail: `${this.config.chatModel} + ${this.config.embedModel}` };
      }
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(6000),
      });

      // 🔴 A MISSING ENDPOINT IS NOT A BROKEN MODEL, and this is the line where that is
      // decided. The probe below asks the provider for its model catalogue because that
      // is free and spends no tokens — but not every provider publishes one.
      //
      // **Cloudflare's OpenAI-compatible endpoint refuses `GET /models` with a 405.** A
      // plain `!response.ok` therefore reported a perfectly working provider as
      // unreachable: the site would have said "the model is not reachable" while
      // answering every question correctly. It was found by calling the route with NO
      // credentials, where the status code says which of three things is true —
      // **401 means the route is real**, **405 means it is real but not for GET**, and
      // **404 means it is not there at all.**
      //
      // So the codes are read for what they mean rather than lumped together:
      //
      //   401 / 403  the credential was refused — a real fault, and a fixable one
      //   402        the account is not entitled to inference — a real fault
      //   404 / 405  this provider publishes no catalogue — NOT a fault
      //   5xx        the provider's own side is down — a real fault
      //
      // A provider with no catalogue is reported as up, with the reason said plainly, so
      // nobody is ever told that a working site is broken. The first real question is
      // the true test, and it fails loudly and specifically if the credential is wrong.
      if (response.status === 404 || response.status === 405) {
        return { ok: true, detail: `${this.config.chatModel} + ${this.config.embedModel} (no catalogue published)` };
      }
      if (!response.ok) {
        const hint =
          response.status === 401 || response.status === 403
            ? 'the model credential was refused'
            : response.status === 402
              ? 'inference is not enabled on that account'
              : `HTTP ${response.status}`;
        return { ok: false, detail: hint };
      }
      return { ok: true, detail: `${this.config.chatModel} + ${this.config.embedModel}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}
