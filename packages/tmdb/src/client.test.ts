import { describe, expect, it } from 'vitest';
import { TmdbClient, TmdbError, redactUrl, type FetchLike } from './client.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue of canned responses, plus a record of what was requested. */
function stubFetch(responses: (Response | Error)[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request to ${url}`);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

function client(responses: (Response | Error)[], maxRetries = 3) {
  const { fetch, calls } = stubFetch(responses);
  const sleeps: number[] = [];
  const instance = new TmdbClient({
    token: 'test-token',
    fetch,
    maxRetries,
    requestsPerSecond: 1000,
    burst: 100,
    random: () => 0,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { instance, calls, sleeps };
}

const configuration = {
  images: {
    secure_base_url: 'https://image.tmdb.org/t/p/',
    poster_sizes: ['w92', 'w500', 'original'],
  },
};

describe('TmdbClient', () => {
  it('refuses an empty token', () => {
    expect(() => new TmdbClient({ token: '  ' })).toThrow(/read access token/u);
  });

  it('sends the token as a bearer header and never in the URL', async () => {
    const { instance, calls } = client([jsonResponse(configuration)]);
    await instance.configuration();
    const call = calls[0];
    expect(call?.url).toBe('https://api.themoviedb.org/3/configuration');
    expect(call?.url).not.toContain('test-token');
    expect(
      (call?.init?.headers as Record<string, string> | undefined)
        ?.authorization,
    ).toBe('Bearer test-token');
  });

  it('appends the blocks the recommender needs to a detail request', async () => {
    const { instance, calls } = client([
      jsonResponse({ id: 1, title: 'Film' }),
    ]);
    await instance.movieDetail(1);
    expect(calls[0]?.url).toBe(
      'https://api.themoviedb.org/3/movie/1?append_to_response=keywords%2Ccredits%2Crelease_dates',
    );
  });

  it('drops undefined query values instead of sending "undefined"', async () => {
    const { instance, calls } = client([
      jsonResponse({ page: 1, results: [], total_pages: 0, total_results: 0 }),
    ]);
    await instance.discoverMovies({
      page: 1,
      with_original_language: undefined,
    });
    expect(calls[0]?.url).toBe(
      'https://api.themoviedb.org/3/discover/movie?page=1',
    );
  });

  it('honours Retry-After on a 429 and then succeeds', async () => {
    const { instance, sleeps, calls } = client([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse(configuration),
    ]);
    await expect(instance.configuration()).resolves.toMatchObject({
      images: { secure_base_url: 'https://image.tmdb.org/t/p/' },
    });
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx with backoff', async () => {
    const { instance, sleeps } = client([
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
      jsonResponse(configuration),
    ]);
    await instance.configuration();
    // Full jitter with random() === 0 halves the exponential ceiling.
    expect(sleeps).toEqual([250, 500]);
  });

  it('retries a network failure', async () => {
    const { instance, calls } = client([
      new Error('ECONNRESET'),
      jsonResponse(configuration),
    ]);
    await instance.configuration();
    expect(calls).toHaveLength(2);
  });

  it('fails fast on a 4xx that is not a rate limit', async () => {
    const { instance, calls } = client([new Response('', { status: 401 })]);
    await expect(instance.configuration()).rejects.toThrow(TmdbError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const { instance, calls } = client(
      Array.from({ length: 3 }, () => new Response('', { status: 500 })),
      2,
    );
    await expect(instance.configuration()).rejects.toThrow(/HTTP 500/u);
    expect(calls).toHaveLength(3);
  });

  it('reports a schema mismatch rather than writing bad data', async () => {
    const { instance } = client([jsonResponse({ images: { nope: true } })]);
    await expect(instance.configuration()).rejects.toThrow(
      /did not match the expected schema/u,
    );
  });

  it('retries a malformed body', async () => {
    const { instance, calls } = client([
      new Response('not json', { status: 200 }),
      jsonResponse(configuration),
    ]);
    await instance.configuration();
    expect(calls).toHaveLength(2);
  });

  it('reports retries without leaking the token', async () => {
    const { fetch } = stubFetch([
      new Response('', { status: 500 }),
      jsonResponse(configuration),
    ]);
    const seen: string[] = [];
    const instance = new TmdbClient({
      token: 'secret-token',
      fetch,
      requestsPerSecond: 1000,
      sleep: () => Promise.resolve(),
      random: () => 0,
      onRetry: (info) => seen.push(`${info.path}:${info.reason}`),
    });
    await instance.configuration();
    expect(seen).toEqual(['/configuration:HTTP 500']);
    expect(JSON.stringify(seen)).not.toContain('secret-token');
  });

  it('does not retry a caller-initiated abort', async () => {
    const controller = new AbortController();
    const { fetch, calls } = stubFetch([]);
    const aborting: FetchLike = (url, init) => {
      controller.abort();
      return fetch(url, init).catch(() => {
        throw new Error('aborted');
      });
    };
    const instance = new TmdbClient({
      token: 'test-token',
      fetch: aborting,
      requestsPerSecond: 1000,
      sleep: () => Promise.resolve(),
    });
    await expect(instance.configuration(controller.signal)).rejects.toThrow(
      /was aborted/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('unwraps the genre list', async () => {
    const { instance } = client([
      jsonResponse({ genres: [{ id: 28, name: 'Action' }] }),
    ]);
    await expect(instance.movieGenres()).resolves.toEqual([
      { id: 28, name: 'Action' },
    ]);
  });

  it('requests a changes window', async () => {
    const { instance, calls } = client([
      jsonResponse({ page: 1, results: [{ id: 7 }], total_pages: 1 }),
    ]);
    await instance.movieChanges('2026-08-01', '2026-08-07', 2);
    expect(calls[0]?.url).toContain('start_date=2026-08-01');
    expect(calls[0]?.url).toContain('page=2');
  });

  it('accepts an HTTP-date Retry-After', async () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const { instance, sleeps } = client([
      new Response('', { status: 429, headers: { 'retry-after': when } }),
      jsonResponse(configuration),
    ]);
    await instance.configuration();
    expect(sleeps[0]).toBeGreaterThan(1000);
  });

  it('falls back to backoff when Retry-After is nonsense', async () => {
    const { instance, sleeps } = client([
      new Response('', { status: 429, headers: { 'retry-after': 'soon' } }),
      jsonResponse(configuration),
    ]);
    await instance.configuration();
    expect(sleeps).toEqual([250]);
  });
});

describe('redactUrl', () => {
  it('masks secret-shaped query parameters', () => {
    expect(
      redactUrl('https://api.themoviedb.org/3/movie/1?api_key=abc123'),
    ).toBe('https://api.themoviedb.org/3/movie/1?api_key=REDACTED');
  });

  it('leaves ordinary parameters alone', () => {
    expect(redactUrl('https://api.themoviedb.org/3/movie/1?page=2')).toBe(
      'https://api.themoviedb.org/3/movie/1?page=2',
    );
  });

  it('passes through anything that is not a URL', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
