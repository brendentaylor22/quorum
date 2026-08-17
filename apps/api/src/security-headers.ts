import { TMDB_IMAGE_BASE_URL } from '@quorum/tmdb';
import type { FastifyInstance } from 'fastify';
import { secureCookies } from './capabilities.js';

/**
 * Response security headers, including the content security policy.
 *
 * Quorum's XSS exposure is small — React escapes text, display names are
 * validated to reject control and bidi characters, and there is no user-supplied
 * HTML, URL, or template anywhere in the product. A policy is still worth its
 * weight, because the value of a successful injection here is unusually high:
 * the capability tokens that *are* the authorization model sit in the URL and in
 * a cookie, and script running on this origin can read one and use the other.
 * Threat model T07 and T13.
 */

const ONE_YEAR_SECONDS = 31_536_000;

/** The origin part of a URL, or null if it will not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface SecurityHeaderOptions {
  /**
   * Where poster images are served from — the `secure_base_url` the importer
   * recorded. TMDB requires images be loaded from their CDN rather than
   * mirrored, so the policy has to name an origin Quorum does not control.
   */
  imageBaseUrl?: string | null;
  /** Whether to assert HSTS. Off wherever insecure cookies are permitted. */
  secure?: boolean;
}

export function contentSecurityPolicy(imageBaseUrl?: string | null): string {
  // The configured origin and the documented default, so a catalog refresh that
  // changes the CDN host cannot blank every poster until the next restart.
  const imageOrigins = new Set<string>(['https://image.tmdb.org']);
  for (const candidate of [imageBaseUrl, TMDB_IMAGE_BASE_URL]) {
    const origin = candidate === null ? null : originOf(candidate ?? '');
    if (origin !== null) imageOrigins.add(origin);
  }

  return [
    // Nothing loads from anywhere unless a directive below says otherwise.
    "default-src 'self'",
    // The built client is a module script and a stylesheet, both first-party.
    // No inline script, no `eval`, no CDN — a strict policy costs nothing here.
    "script-src 'self'",
    // `'unsafe-inline'` is required only for style *attributes*: the swipe card
    // sets its transform from a drag position, and the roster sets a progress
    // width. Both are numbers computed by our own code, never user input.
    // CSP cannot distinguish an attribute from an inline `<style>` block
    // without hashing every value, so this is the honest cost of animating a
    // card at all.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${[...imageOrigins].join(' ')}`,
    // The API is same-origin. Nothing else should ever be reachable.
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // Clickjacking a vote button is a real attack on a product whose entire
    // interaction is two buttons.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join('; ');
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions = {},
): void {
  const policy = contentSecurityPolicy(options.imageBaseUrl);
  const secure = options.secure ?? secureCookies();

  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('content-security-policy', policy);
    reply.header('x-content-type-options', 'nosniff');
    // Capability tokens are in the path, so a referrer is a token leak to any
    // third-party origin the page touches — starting with the poster CDN.
    // The client also sets this as a meta tag; both, because a header covers
    // responses the client never renders.
    reply.header('referrer-policy', 'no-referrer');
    // `frame-ancestors` supersedes this for anything current, but it costs one
    // header to also stop a browser that never learned CSP.
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    // Quorum needs no device capability at all. Saying so explicitly means a
    // future dependency cannot quietly start asking for one.
    reply.header(
      'permissions-policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    );
    if (secure) {
      reply.header(
        'strict-transport-security',
        `max-age=${ONE_YEAR_SECONDS.toString()}; includeSubDomains`,
      );
    }
    done(null, payload);
  });
}
