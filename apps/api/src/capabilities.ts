import { databasePath } from '@quorum/database';
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INVITE_WORDS } from './invite-words.js';

/** 256 bits of entropy per capability; the contract floor is 128. */
const CAPABILITY_BYTES = 32;
/** 128 bits for opaque public identifiers, which are not capabilities. */
const PUBLIC_ID_BYTES = 16;

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function developmentSecretPath(databaseFile: string): string {
  return join(dirname(resolve(databaseFile)), 'dev-token-secret');
}

/**
 * Key used to derive stored capability hashes. Production must supply it;
 * development persists a generated key beside the database so sessions and
 * invite links survive a restart.
 */
export function resolveTokenSecret(databaseFile = databasePath()): Buffer {
  // A mounted secret file keeps the key out of the process environment.
  const secretFile = process.env.QUORUM_TOKEN_SECRET_FILE;
  if (secretFile !== undefined && secretFile.length > 0) {
    const contents = readFileSync(secretFile, 'utf8').trim();
    if (contents.length < 32) {
      throw new Error(
        `Token secret in ${secretFile} must be at least 32 characters`,
      );
    }
    return Buffer.from(contents, 'utf8');
  }
  const configured = process.env.QUORUM_TOKEN_SECRET;
  if (configured !== undefined && configured.length > 0) {
    if (configured.length < 32) {
      throw new Error('QUORUM_TOKEN_SECRET must be at least 32 characters');
    }
    return Buffer.from(configured, 'utf8');
  }
  if (isProduction()) {
    throw new Error(
      'QUORUM_TOKEN_SECRET or QUORUM_TOKEN_SECRET_FILE is required in production',
    );
  }
  const path = developmentSecretPath(databaseFile);
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8'), 'hex');
  const generated = randomBytes(CAPABILITY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated.toString('hex'), { mode: 0o600 });
  chmodSync(path, 0o600);
  return generated;
}

/**
 * Cookies may drop the `Secure` attribute only for plain-HTTP local
 * development, and never in a production build.
 */
export function secureCookies(): boolean {
  if (isProduction()) return true;
  return process.env.QUORUM_ALLOW_INSECURE_COOKIES !== '1';
}

export function issueCapability(): string {
  return randomBytes(CAPABILITY_BYTES).toString('base64url');
}

/** Words per invite phrase. See `issueInviteCapability` for the trade. */
export const INVITE_PHRASE_WORDS = 6;

/**
 * An invite capability, as words rather than base64.
 *
 * The invite is the one capability that gets read aloud, retyped from a
 * screen, or dictated across a room, and 43 characters of base64 survives none
 * of those. Six words from a 7772-word list carry ~77.5 bits — below the
 * 256-bit host and session tokens, and below the 128-bit floor the other
 * capabilities hold to.
 *
 * That is a deliberate, bounded reduction. An invite grants entry to one room
 * that expires within 24 hours and holds at most 20 people; it confers no host
 * authority, and the host token it is issued beside is untouched. At ~77.5
 * bits an attacker averages ~10^23 guesses, which no amount of unthrottled
 * HTTP closes within a room's lifetime. It is still worth far less margin than
 * the rest of the system carries, which is why `docs/threat-model.md`
 * now records the invite floor separately from the others.
 *
 * `randomInt` rather than a modulo of random bytes: 2^n is not divisible by
 * 7772, so folding bytes down would quietly favour the front of the list and
 * cost real entropy. Node's `randomInt` rejects out-of-range draws instead.
 */
export function issueInviteCapability(): string {
  const words: string[] = [];
  for (let index = 0; index < INVITE_PHRASE_WORDS; index += 1) {
    words.push(INVITE_WORDS[randomInt(INVITE_WORDS.length)] ?? '');
  }
  return words.join('-');
}

export function issuePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}

/**
 * Derive the stored keyed hash of a capability.
 *
 * Host and session capabilities are stored as this hash and nothing else. The
 * invite is the one exception: migration `0007` keeps `rooms.invite_token`
 * beside its hash so the host screen can re-share a room minted outside a
 * browser. That is threat model T01b — accepted, bounded to a live lobby, and
 * cleared by `markRoomExpired`.
 */
export function hashCapability(secret: Buffer, token: string): string {
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

export function capabilitiesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
