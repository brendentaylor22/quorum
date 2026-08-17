import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureCatalog, selectSlate } from './index.js';

function writeFixture(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-catalog-'));
  const path = join(directory, 'movies.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('loadFixtureCatalog', () => {
  it('loads the repository fixture with at least a full slate', () => {
    const items = loadFixtureCatalog();
    expect(items.length).toBeGreaterThanOrEqual(20);
    for (const item of items) {
      expect(item.mediaType).toBe('MOVIE');
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.posterRef).not.toBeNull();
      expect(item.catalogVersion.length).toBeGreaterThan(0);
    }
  });

  it('drops adult and low-quality entries', () => {
    const path = writeFixture({
      fixture_version: 'test-v1',
      source: 'synthetic',
      movies: [
        {
          fixture_id: 'keep',
          title: 'Keep',
          year: 2020,
          synopsis: 'Fine',
          runtime_minutes: 90,
          content_rating: 'PG',
          language: 'en',
          poster_ref: 'fixture://poster/keep',
        },
        {
          fixture_id: 'adult',
          title: 'Adult',
          year: 2020,
          synopsis: 'Fine',
          runtime_minutes: 90,
          content_rating: 'R',
          language: 'en',
          poster_ref: 'fixture://poster/adult',
          adult: true,
        },
        {
          fixture_id: 'no-poster',
          title: 'No poster',
          year: 2020,
          synopsis: 'Fine',
          runtime_minutes: 90,
          content_rating: 'PG',
          language: 'en',
          poster_ref: null,
        },
      ],
    });
    expect(loadFixtureCatalog(path).map((item) => item.providerRef)).toEqual([
      'keep',
    ]);
  });

  it('rejects duplicate provider references', () => {
    const movie = {
      fixture_id: 'same',
      title: 'Same',
      year: 2020,
      synopsis: 'Fine',
      runtime_minutes: 90,
      content_rating: 'PG',
      language: 'en',
      poster_ref: 'fixture://poster/same',
    };
    const path = writeFixture({
      fixture_version: 'test-v1',
      source: 'synthetic',
      movies: [movie, movie],
    });
    expect(() => loadFixtureCatalog(path)).toThrow(/Duplicate catalog/u);
  });

  it('rejects a malformed fixture file', () => {
    const path = writeFixture({ movies: [] });
    expect(() => loadFixtureCatalog(path)).toThrow();
  });
});

describe('selectSlate', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => index);

  it('is deterministic for a given seed', () => {
    expect(selectSlate(candidates, 20, 'seed-a')).toEqual(
      selectSlate(candidates, 20, 'seed-a'),
    );
  });

  it('varies by seed and never repeats an item', () => {
    const first = selectSlate(candidates, 20, 'seed-a');
    const second = selectSlate(candidates, 20, 'seed-b');
    expect(new Set(first).size).toBe(20);
    expect(first).not.toEqual(second);
  });

  it('refuses to build a short slate', () => {
    expect(() => selectSlate(candidates.slice(0, 5), 20, 'seed')).toThrow(
      /usable items/u,
    );
  });
});
