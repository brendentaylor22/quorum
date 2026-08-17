import { HOST_TOKEN_HEADER } from '@quorum/contracts';

/**
 * Capability tokens travel in URL paths, because an invite has to be a link a
 * person can open. That makes the request line itself a secret: a default
 * access log records `/api/host/<256 bits of host authority>` on every poll,
 * and log files outlive rooms, get shipped to aggregators, and get pasted into
 * bug reports. Threat model T11 and T13 both land here.
 *
 * Every route that takes a capability in its path is listed below. The token is
 * always the segment immediately after the prefix, so the path shape — which is
 * what a log is for — survives redaction while the secret does not.
 */
const CAPABILITY_PATH =
  /^(\/api\/invites\/|\/api\/host\/|\/join\/|\/host\/)([^/?#]+)/u;

export const REDACTED = '[redacted]';

/**
 * Strip capability tokens from a request path, preserving method, route shape,
 * and query string. Anything not matching a known capability route is returned
 * unchanged — an unknown path cannot contain a token Quorum issued.
 */
export function redactCapabilityPath(url: string): string {
  return url.replace(CAPABILITY_PATH, `$1${REDACTED}`);
}

/**
 * Pino configuration for the serving process. The request serializer replaces
 * Fastify's default so a token can never reach a log line through `req.url`,
 * and the `redact` paths are belt-and-braces for anything that logs a whole
 * request or reply: the host-capability header, the session cookie, and the
 * `Set-Cookie` that issues one.
 */
export interface LoggableRequest {
  method: string;
  url: string;
  ip: string;
}

export const loggerOptions = {
  redact: {
    paths: [
      `req.headers["${HOST_TOKEN_HEADER}"]`,
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.cookie',
      `headers["${HOST_TOKEN_HEADER}"]`,
    ],
    censor: REDACTED,
  },
  serializers: {
    req(request: LoggableRequest) {
      return {
        method: request.method,
        url: redactCapabilityPath(request.url),
        // `request.ip` honours `trustProxy`, which is off unless an operator
        // deliberately puts a trusted proxy in front. Without it this is the
        // socket peer, which is the only source worth believing.
        remoteAddress: request.ip,
      };
    },
  },
};
