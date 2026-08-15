import type { TmdbConfiguration } from './schemas.js';

/**
 * TMDB requires this notice wherever their data is presented, and requires
 * images be served from their CDN rather than mirrored. Both obligations apply
 * regardless of how small or private the deployment is.
 */
export const TMDB_ATTRIBUTION =
  'This product uses the TMDB API but is not endorsed or certified by TMDB.';

/** Fallback base URL, used only if `/configuration` is unavailable. */
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

export interface PosterUrlOptions {
  /** `images.secure_base_url` from `/configuration`. */
  baseUrl?: string;
  /** A size from `images.poster_sizes`, e.g. `w500`. */
  size?: string;
}

/**
 * Build a poster URL from a stored `poster_path`. Returns null when the item
 * has no poster so callers render a placeholder instead of a broken image.
 */
export function posterUrl(
  posterPath: string | null,
  options: PosterUrlOptions = {},
): string | null {
  if (posterPath === null || posterPath.trim() === '') return null;
  const base = (options.baseUrl ?? TMDB_IMAGE_BASE_URL).replace(/\/+$/u, '');
  const size = options.size ?? 'w500';
  const path = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
  return `${base}/${size}${path}`;
}

/**
 * Largest non-`original` poster size TMDB offers, so the client requests a
 * bounded image rather than a full-resolution master.
 */
export function preferredPosterSize(
  configuration: TmdbConfiguration,
  maxWidth = 500,
): string {
  const sized = configuration.images.poster_sizes
    .map((size) => ({
      size,
      width: Number(/^w(\d+)$/u.exec(size)?.[1] ?? NaN),
    }))
    .filter((entry) => Number.isFinite(entry.width) && entry.width <= maxWidth)
    .sort((left, right) => right.width - left.width);
  return sized[0]?.size ?? 'w500';
}
