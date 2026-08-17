import { describe, expect, it } from 'vitest';
import {
  TMDB_ATTRIBUTION,
  posterUrl,
  preferredPosterSize,
} from './attribution.js';
import { configurationSchema } from './schemas.js';

const configuration = configurationSchema.parse({
  images: {
    secure_base_url: 'https://image.tmdb.org/t/p/',
    poster_sizes: ['w92', 'w185', 'w500', 'w780', 'original'],
  },
});

describe('TMDB_ATTRIBUTION', () => {
  it('carries the wording TMDB requires', () => {
    expect(TMDB_ATTRIBUTION).toContain('TMDB API');
    expect(TMDB_ATTRIBUTION).toContain('not endorsed or certified');
  });
});

describe('posterUrl', () => {
  it('builds a CDN URL from a stored path', () => {
    expect(posterUrl('/matrix.jpg')).toBe(
      'https://image.tmdb.org/t/p/w500/matrix.jpg',
    );
  });

  it('uses the configured base and size', () => {
    expect(
      posterUrl('/matrix.jpg', {
        baseUrl: configuration.images.secure_base_url,
        size: 'w780',
      }),
    ).toBe('https://image.tmdb.org/t/p/w780/matrix.jpg');
  });

  it('tolerates a path without a leading slash', () => {
    expect(posterUrl('matrix.jpg')).toBe(
      'https://image.tmdb.org/t/p/w500/matrix.jpg',
    );
  });

  it('returns null when there is no poster', () => {
    expect(posterUrl(null)).toBeNull();
    expect(posterUrl('   ')).toBeNull();
  });
});

describe('preferredPosterSize', () => {
  it('picks the largest bounded size and never "original"', () => {
    expect(preferredPosterSize(configuration)).toBe('w500');
    expect(preferredPosterSize(configuration, 800)).toBe('w780');
  });

  it('falls back when no size fits the bound', () => {
    const narrow = configurationSchema.parse({
      images: {
        secure_base_url: 'https://image.tmdb.org/t/p/',
        poster_sizes: ['original'],
      },
    });
    expect(preferredPosterSize(narrow)).toBe('w500');
  });
});
