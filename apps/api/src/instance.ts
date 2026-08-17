import type { InstanceInfo } from '@quorum/contracts';

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

export function instanceInfo(
  environment: NodeJS.ProcessEnv = process.env,
): InstanceInfo {
  const configured = environment.QUORUM_SOURCE_URL?.trim();
  const modified = configured !== undefined && configured !== '';
  return {
    sourceUrl: modified ? configured : UPSTREAM_SOURCE_URL,
    licence: LICENCE,
    modified,
  };
}
