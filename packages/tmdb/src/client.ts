import type { z } from 'zod';
import { RateLimiter, realSleep, type Sleep } from './rate-limit.js';
import {
  changesPageSchema,
  configurationSchema,
  discoverPageSchema,
  genreListSchema,
  movieDetailSchema,
  type TmdbChangesPage,
  type TmdbConfiguration,
  type TmdbDiscoverPage,
  type TmdbGenre,
  type TmdbMovieDetail,
} from './schemas.js';

export const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

/** TMDB caps `/discover` paging; a query claiming more is silently truncated. */
export const TMDB_MAX_PAGES = 500;
export const TMDB_RESULTS_PER_PAGE = 20;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined;

export class TmdbError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

export interface TmdbClientOptions {
  /**
   * TMDB v4 read access token. Sent as a bearer header so it never reaches a
   * URL, and therefore never reaches a log line, proxy record, or error
   * message. Never accept it from anything but a server-side secret file.
   */
  token: string;
  baseUrl?: string;
  fetch?: FetchLike;
  requestsPerSecond?: number;
  burst?: number;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: Sleep;
  random?: () => number;
  /** Called before each retry. Wire to the operator log; never logs secrets. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  path: string;
  attempt: number;
  status: number | null;
  delayMs: number;
  reason: string;
}

interface RequestOptions {
  query?: Record<string, QueryValue> | undefined;
  signal?: AbortSignal | undefined;
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30_000;

/** Strip anything secret-shaped so a URL is safe to put in an error. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ['api_key', 'session_id', 'access_token']) {
      if (parsed.searchParams.has(key))
        parsed.searchParams.set(key, 'REDACTED');
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Minimal TMDB read client: rate limited, retried, and schema validated.
 *
 * Everything is injectable (`fetch`, `sleep`, `random`) so the importer can be
 * tested end to end without network access.
 */
export class TmdbClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly onRetry: ((info: RetryInfo) => void) | undefined;

  constructor(options: TmdbClientOptions) {
    if (options.token.trim() === '') {
      throw new Error('TMDB client requires a read access token');
    }
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? TMDB_BASE_URL).replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 5;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
    this.limiter = new RateLimiter({
      requestsPerSecond: options.requestsPerSecond ?? 20,
      burst: options.burst ?? 10,
      sleep: this.sleep,
    });
  }

  configuration(signal?: AbortSignal): Promise<TmdbConfiguration> {
    return this.request('/configuration', configurationSchema, { signal });
  }

  async movieGenres(
    language = 'en-US',
    signal?: AbortSignal,
  ): Promise<TmdbGenre[]> {
    const page = await this.request('/genre/movie/list', genreListSchema, {
      query: { language },
      signal,
    });
    return page.genres;
  }

  discoverMovies(
    query: Record<string, QueryValue>,
    signal?: AbortSignal,
  ): Promise<TmdbDiscoverPage> {
    return this.request('/discover/movie', discoverPageSchema, {
      query,
      signal,
    });
  }

  /**
   * Full movie record with the appended blocks the recommender needs. One call
   * per movie; `append_to_response` avoids three more round trips each.
   */
  movieDetail(id: number, signal?: AbortSignal): Promise<TmdbMovieDetail> {
    return this.request(`/movie/${id.toString()}`, movieDetailSchema, {
      query: { append_to_response: 'keywords,credits,release_dates' },
      signal,
    });
  }

  /** Movie IDs changed in a date window, for incremental refreshes. */
  movieChanges(
    startDate: string,
    endDate: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<TmdbChangesPage> {
    return this.request('/movie/changes', changesPageSchema, {
      query: { start_date: startDate, end_date: endDate, page },
      signal,
    });
  }

  private buildUrl(path: string, query: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query ?? {});
    let attempt = 0;

    for (;;) {
      await this.limiter.acquire();
      const outcome = await this.attempt(url, path, options.signal);

      if (outcome.kind === 'ok') {
        const parsed = schema.safeParse(outcome.body);
        if (!parsed.success) {
          throw new TmdbError(
            outcome.status,
            path,
            `TMDB response for ${path} did not match the expected schema`,
            parsed.error,
          );
        }
        return parsed.data;
      }

      if (!outcome.retryable || attempt >= this.maxRetries) {
        throw new TmdbError(
          outcome.status ?? 0,
          path,
          `TMDB request failed for ${redactUrl(url)}: ${outcome.reason}`,
          outcome.cause,
        );
      }

      const delayMs = outcome.retryAfterMs ?? this.backoff(attempt);
      this.onRetry?.({
        path,
        attempt: attempt + 1,
        status: outcome.status,
        delayMs,
        reason: outcome.reason,
      });
      await this.sleep(delayMs);
      attempt += 1;
    }
  }

  private async attempt(
    url: string,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
        },
        signal: composed,
      });
    } catch (cause) {
      // A caller-initiated abort is deliberate and must not be retried.
      if (signal?.aborted === true) {
        throw new TmdbError(
          0,
          path,
          `TMDB request for ${path} was aborted`,
          cause,
        );
      }
      return {
        kind: 'error',
        status: null,
        retryable: true,
        reason: cause instanceof Error ? cause.message : 'network error',
        cause,
      };
    }

    if (response.ok) {
      try {
        return {
          kind: 'ok',
          status: response.status,
          body: await response.json(),
        };
      } catch (cause) {
        return {
          kind: 'error',
          status: response.status,
          retryable: true,
          reason: 'response body was not valid JSON',
          cause,
        };
      }
    }

    if (response.status === 429) {
      return {
        kind: 'error',
        status: 429,
        retryable: true,
        reason: 'rate limited',
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      };
    }

    return {
      kind: 'error',
      status: response.status,
      // 5xx is transient; 4xx means the request itself is wrong.
      retryable: response.status >= 500,
      reason: `HTTP ${response.status.toString()}`,
    };
  }

  /** Exponential backoff with full jitter, so parallel workers desynchronise. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
    return Math.ceil(ceiling * (0.5 + this.random() * 0.5));
  }
}

type Attempt =
  | { kind: 'ok'; status: number; body: unknown }
  | {
      kind: 'error';
      status: number | null;
      retryable: boolean;
      reason: string;
      retryAfterMs?: number | undefined;
      cause?: unknown;
    };

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(RETRY_CAP_MS, Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(header);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(RETRY_CAP_MS, Math.max(0, timestamp - Date.now()));
}
