import type { InstanceInfo, RoomCreationMode } from '@quorum/contracts';

/**
 * Where this instance's source lives.
 *
 * The AGPL asks that people interacting with a modified copy over a network be
 * offered its source. The upstream repository is the right answer for an
 * unmodified deployment and the wrong one for a fork, so an operator who
 * changed anything sets `QUORUM_SOURCE_URL` to their own. Defaulting to
 * upstream is the useful behaviour for the common case; lying about it is the
 * operator's choice to make, not something the code can prevent.
 */
const UPSTREAM_SOURCE_URL = 'https://github.com/brendentaylor22/quorum';

export const LICENCE = 'AGPL-3.0-or-later';

/**
 * The hostname on which this instance still accepts room creation while
 * `QUORUM_ROOM_CREATION=operator` closes it everywhere else.
 *
 * It exists for the deployment where the operator wants the create button back
 * on a phone without opening it to the Internet: a second public hostname,
 * routed to this same origin, with an identity proxy in front of it — a
 * Cloudflare Access application, an oauth2-proxy, HTTP basic auth. The proxy
 * authenticates; this setting is only what keeps the public hostname closed
 * while the protected one works.
 *
 * Unset — the default — nothing changes, and `operator` means the CLI.
 */
export function operatorHostname(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.QUORUM_OPERATOR_HOSTNAME?.trim();
  if (configured === undefined || configured === '') return undefined;
  return normaliseHostname(configured);
}

/**
 * A `Host` header reduced to the name alone: lowercased, port removed, and a
 * fully-qualified trailing dot dropped, so `Start.Example.org.:443` and
 * `start.example.org` are the one hostname they plainly are.
 *
 * Only ever called with the literal `Host` header. `X-Forwarded-Host` must not
 * reach it: see `routes.ts`.
 */
export function normaliseHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // An IPv6 literal carries its own colons inside brackets, so the port is
  // whatever follows the closing one; everything else ends at the first colon.
  const separator = trimmed.startsWith('[')
    ? trimmed.indexOf(']') + 1
    : trimmed.indexOf(':');
  const host =
    separator > 0 ? trimmed.slice(0, separator) : trimmed.replace(':', '');
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Who may create a room here.
 *
 * `public` stays the default because it is what makes a fresh install playable
 * without a shell. An operator who publishes Quorum on a hostname strangers can
 * reach — and who intends to be the only host — sets `operator`, which closes
 * `POST /api/rooms` and leaves `create-room` on the CLI as the only way in.
 *
 * `operator` has one escape hatch, and only when the operator opens it:
 * `QUORUM_OPERATOR_HOSTNAME`. A request whose `Host` is that name is treated as
 * `public`, so a hostname the operator has put an identity proxy in front of
 * gets the create button back while the hostname friends use stays closed.
 *
 * Anything other than the two known values is a typo in an operator's `.env`,
 * and the safe reading of a typo in a setting whose whole job is to restrict
 * access is the restrictive one. A misspelling that silently reopened the
 * endpoint would be the one failure this setting exists to prevent.
 */
export function roomCreationMode(
  environment: NodeJS.ProcessEnv = process.env,
  requestHostname?: string,
): RoomCreationMode {
  const configured = environment.QUORUM_ROOM_CREATION?.trim().toLowerCase();
  if (configured === undefined || configured === '') return 'public';
  if (configured === 'public') return 'public';
  const operator = operatorHostname(environment);
  if (operator === undefined || requestHostname === undefined)
    return 'operator';
  return normaliseHostname(requestHostname) === operator
    ? 'public'
    : 'operator';
}

/**
 * Where rooms are played, told to a client that loaded the page somewhere
 * else. Only an operator hostname gets an answer: everywhere else the page is
 * already on the public origin and relative links are correct.
 *
 * Without `QUORUM_PUBLIC_URL` there is nothing to send, and the operator page
 * falls back to relative links — a working room on the protected hostname,
 * with an invite the operator has to rewrite by hand. Which is why
 * `QUORUM_PUBLIC_URL` is documented as required alongside the hostname.
 */
function publicUrl(
  environment: NodeJS.ProcessEnv,
  requestHostname: string | undefined,
): string | undefined {
  const operator = operatorHostname(environment);
  if (operator === undefined || requestHostname === undefined) return undefined;
  if (normaliseHostname(requestHostname) !== operator) return undefined;
  const configured = environment.QUORUM_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (configured === undefined || configured === '') return undefined;
  return URL.canParse(configured) ? configured : undefined;
}

export function instanceInfo(
  environment: NodeJS.ProcessEnv = process.env,
  requestHostname?: string,
): InstanceInfo {
  const configured = environment.QUORUM_SOURCE_URL?.trim();
  const modified = configured !== undefined && configured !== '';
  const rooms = publicUrl(environment, requestHostname);
  return {
    sourceUrl: modified ? configured : UPSTREAM_SOURCE_URL,
    licence: LICENCE,
    modified,
    roomCreation: roomCreationMode(environment, requestHostname),
    ...(rooms === undefined ? {} : { publicUrl: rooms }),
  };
}
