import { z } from 'zod';

/** Exactly 20 movies per room, per the product contract. */
export const SLATE_SIZE = 20;
/**
 * A room's 20 are drawn at random from a shortlist of the catalog, not from
 * the whole of it. Wide enough that two rooms rarely collide, narrow enough
 * that everything in it is worth someone's evening. How the shortlist is
 * ranked lives in `listSlateCandidateIds`.
 */
export const SLATE_CANDIDATE_POOL_SIZE = 500;
/** Hard cap from `docs/phase-0/retention-and-abuse.md`. */
export const MAX_PARTICIPANTS_PER_ROOM = 20;
export const DISPLAY_NAME_MAX_LENGTH = 40;

const disallowedRanges: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
];

function hasDisallowedCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return disallowedRanges.some(([low, high]) => code >= low && code <= high);
  });
}

export const displayNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => value.length >= 1, 'Display name is required')
  .refine(
    (value) => Array.from(value).length <= DISPLAY_NAME_MAX_LENGTH,
    `Display name must be ${DISPLAY_NAME_MAX_LENGTH.toString()} characters or fewer`,
  )
  .refine(
    (value) => !hasDisallowedCharacter(value),
    'Display name contains disallowed characters',
  );

/** Opaque server-generated identifiers exposed to clients. */
export const publicIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{10,64}$/u, 'Malformed identifier');

/**
 * Shape check for a capability in a URL, not an entropy guarantee — the
 * issuing side owns that. Host and session tokens are 256-bit base64url;
 * invites are six hyphenated words, which fall inside the same character
 * class and length band. See `issueInviteCapability` for that trade.
 */
export const capabilityTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,128}$/u, 'Malformed capability');

export const roomStateSchema = z.enum([
  'LOBBY',
  'VOTING',
  'COMPLETE',
  'EXPIRED',
]);
export type RoomState = z.infer<typeof roomStateSchema>;

export const choiceSchema = z.enum(['LEFT', 'RIGHT']);
export type Choice = z.infer<typeof choiceSchema>;

export const catalogItemSchema = z.object({
  catalogItemId: z.string(),
  title: z.string(),
  year: z.number().int().nullable(),
  synopsis: z.string().nullable(),
  runtimeMinutes: z.number().int().nullable(),
  contentRating: z.string().nullable(),
  /**
   * Display genre names, in the provider's own order. Empty when the catalog
   * carries no genre data, which is the case for the development fixture.
   */
  genres: z.array(z.string()),
  /** Raw provider reference, kept for diagnostics. Not a URL. */
  posterRef: z.string().nullable(),
  /**
   * Ready-to-render poster URL on the provider's CDN, or null when the item
   * has no poster or the catalog carries no image configuration. The server
   * builds it so the client never has to know a provider's URL scheme.
   */
  posterUrl: z.url().nullable(),
});
export type CatalogItemDto = z.infer<typeof catalogItemSchema>;

export const createRoomRequestSchema = z.object({
  displayName: displayNameSchema.optional(),
});
export type CreateRoomRequest = z.input<typeof createRoomRequestSchema>;

export const createRoomResponseSchema = z.object({
  roomId: publicIdSchema,
  inviteToken: capabilityTokenSchema,
  hostToken: capabilityTokenSchema,
  invitePath: z.string(),
  hostPath: z.string(),
  state: roomStateSchema,
  expiresAt: z.iso.datetime(),
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

export const joinRequestSchema = z.object({
  displayName: displayNameSchema,
});
export type JoinRequest = z.input<typeof joinRequestSchema>;

export const participantSummarySchema = z.object({
  participantId: publicIdSchema,
  displayName: z.string(),
  isHost: z.boolean(),
  confirmedCount: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type ParticipantSummary = z.infer<typeof participantSummarySchema>;

/**
 * Predicted group willingness for one slate item, as a percentage. Null
 * wherever no score drove the pick: a top-rated slate, or an exploration slot
 * filled at random.
 */
export const recommendationScoreSchema = z
  .number()
  .int()
  .min(0)
  .max(100)
  .nullable();

export const exposureCardSchema = z.object({
  exposureId: publicIdSchema,
  slatePosition: z.number().int().positive(),
  slateSize: z.number().int().positive(),
  item: catalogItemSchema,
  /** Why the recommender chose this item. Null on a top-rated slate. */
  reason: z.string().nullable(),
  score: recommendationScoreSchema,
});
export type ExposureCard = z.infer<typeof exposureCardSchema>;

/** How a round's slate was chosen; shown so a later slate can be explained. */
export const slateStrategySchema = z.enum(['TOP_RATED', 'RECOMMENDED']);
export type SlateStrategy = z.infer<typeof slateStrategySchema>;

export const roundSummarySchema = z.object({
  roundNumber: z.number().int().positive(),
  strategy: slateStrategySchema,
  slateSize: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type RoundSummary = z.infer<typeof roundSummarySchema>;

export const roomViewSchema = z.object({
  roomId: publicIdSchema,
  state: roomStateSchema,
  isHost: z.boolean(),
  closedEarly: z.boolean(),
  slateSize: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative().nullable(),
  participants: z.array(participantSummarySchema),
  you: participantSummarySchema.nullable(),
  /** Next unconfirmed exposure for the calling participant, if any. */
  card: exposureCardSchema.nullable(),
  resultsAvailable: z.boolean(),
  /** The round in progress, or the most recent one once voting has ended. */
  round: roundSummarySchema.nullable(),
  /** Completed round numbers, oldest first, each with readable results. */
  completedRounds: z.array(z.number().int().positive()),
  /**
   * Whether the host may open another round. False when voting is still open,
   * or when too few unseen movies remain to build a full slate.
   */
  canContinue: z.boolean(),
});
export type RoomView = z.infer<typeof roomViewSchema>;

export const joinResponseSchema = z.object({
  participantId: publicIdSchema,
  room: roomViewSchema,
});
export type JoinResponse = z.infer<typeof joinResponseSchema>;

export const swipeRequestSchema = z.object({
  exposureId: publicIdSchema,
  choice: choiceSchema,
});
export type SwipeRequest = z.infer<typeof swipeRequestSchema>;

export const swipeResponseSchema = z.object({
  exposureId: publicIdSchema,
  choice: choiceSchema,
  confirmedAt: z.iso.datetime(),
  room: roomViewSchema,
});
export type SwipeResponse = z.infer<typeof swipeResponseSchema>;

export const rankedItemSchema = z.object({
  rank: z.number().int().positive(),
  catalogItemId: z.string(),
  slatePosition: z.number().int().positive(),
  item: catalogItemSchema,
  /** Why the recommender chose this item. Null on a top-rated slate. */
  reason: z.string().nullable(),
  /** What the recommender predicted, so a round can be judged against it. */
  score: recommendationScoreSchema,
  yes: z.number().int().nonnegative(),
  responses: z.number().int().nonnegative(),
  eligible: z.number().int().positive(),
  approvalPct: z.number().int().min(0).max(100),
  coveragePct: z.number().int().min(0).max(100),
  yesFraction: z.string(),
  match: z.boolean(),
});
export type RankedItemDto = z.infer<typeof rankedItemSchema>;

export const resultsResponseSchema = z.object({
  roomId: publicIdSchema,
  state: roomStateSchema,
  closedEarly: z.boolean(),
  eligibleCount: z.number().int().positive(),
  completedAt: z.iso.datetime().nullable(),
  items: z.array(rankedItemSchema),
  roundNumber: z.number().int().positive(),
  strategy: slateStrategySchema,
  completedRounds: z.array(z.number().int().positive()),
});
export type ResultsResponse = z.infer<typeof resultsResponseSchema>;

/**
 * Public description of where movie metadata came from. Carries the notice the
 * provider requires, so the client never has to hard-code an attribution that
 * could drift out of step with the actual source.
 */
export const catalogSourceSchema = z.object({
  provider: z.string().nullable(),
  version: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  attribution: z.string().nullable(),
  /** Provider CDN base for posters, or null when none is configured. */
  imageBaseUrl: z.string().nullable(),
});
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

/** Who is allowed to create a room on this instance. */
export const roomCreationModeSchema = z.enum(['public', 'operator']);
export type RoomCreationMode = z.infer<typeof roomCreationModeSchema>;

/**
 * What this instance is, for the two things every deployment owes the people
 * using it: a way to reach the source, and a way to read the privacy notice.
 *
 * The source URL is configuration rather than a constant because Quorum is
 * AGPL-licensed. An operator running a modified copy owes their users *their*
 * source, not the upstream repository's, and the only honest way to offer it is
 * to let them say where it is.
 */
export const instanceInfoSchema = z.object({
  sourceUrl: z.url(),
  licence: z.string(),
  /** Set by an operator who has modified Quorum, purely so the UI can say so. */
  modified: z.boolean(),
  /**
   * Who may create a room. `public` is the shipped default: anyone who loads
   * the page can start one. `operator` closes the endpoint and leaves room
   * creation to the CLI, for a deployment on a public hostname whose only
   * intended hosts are the people with shell access.
   *
   * Published here so the client can say "by invitation only" instead of
   * rendering a button that answers 403. It describes policy, not a secret:
   * anyone can learn the same thing by pressing the button.
   */
  roomCreation: roomCreationModeSchema,
});
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;

/**
 * Uniform error envelope. Invalid, expired, and unauthorized private links all
 * answer `not_found` so that room existence never leaks.
 */
export const errorCodeSchema = z.enum([
  'not_found',
  'invalid_request',
  'conflict',
  'too_many_participants',
  'rate_limited',
  // Distinct from `not_found` on purpose: this one hides nothing. The mode is
  // already published on `/api/instance`, and a caller who cannot tell "closed"
  // from "broken" retries forever.
  'room_creation_disabled',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorResponseSchema = z.object({
  error: errorCodeSchema,
  message: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Cookie name carrying a room-scoped anonymous participant session. */
export function sessionCookieName(roomId: string): string {
  return `quorum_session_${roomId}`;
}

/** Header carrying the host-control capability. Never sent automatically. */
export const HOST_TOKEN_HEADER = 'x-quorum-host-token';
/** Header proving a same-origin fetch, checked on every mutation. */
export const REQUEST_HEADER = 'x-quorum-request';
