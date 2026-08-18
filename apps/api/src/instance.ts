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
 * Who may create a room here.
 *
 * `public` stays the default because it is what makes a fresh install playable
 * without a shell. An operator who publishes Quorum on a hostname strangers can
 * reach — and who intends to be the only host — sets `operator`, which closes
 * `POST /api/rooms` and leaves `create-room` on the CLI as the only way in.
 *
 * Anything other than the two known values is a typo in an operator's `.env`,
 * and the safe reading of a typo in a setting whose whole job is to restrict
 * access is the restrictive one. A misspelling that silently reopened the
 * endpoint would be the one failure this setting exists to prevent.
 */
export function roomCreationMode(
  environment: NodeJS.ProcessEnv = process.env,
): RoomCreationMode {
  const configured = environment.QUORUM_ROOM_CREATION?.trim().toLowerCase();
  if (configured === undefined || configured === '') return 'public';
  return configured === 'public' ? 'public' : 'operator';
}

export function instanceInfo(
  environment: NodeJS.ProcessEnv = process.env,
): InstanceInfo {
  const configured = environment.QUORUM_SOURCE_URL?.trim();
  const modified = configured !== undefined && configured !== '';
  return {
    sourceUrl: modified ? configured : UPSTREAM_SOURCE_URL,
    licence: LICENCE,
    modified,
    roomCreation: roomCreationMode(environment),
  };
}
