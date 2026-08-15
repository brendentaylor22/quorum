import type {
  CatalogItemDto,
  ExposureCard,
  RoundSummary,
} from '@quorum/contracts';
import { useEffect, useRef, useState } from 'react';

interface SwipeDeckProps {
  card: ExposureCard;
  /** The round being voted on, so a later slate can announce itself. */
  round: RoundSummary | null;
  busy: boolean;
  onChoice: (choice: 'LEFT' | 'RIGHT') => void;
}

const DRAG_THRESHOLD_PX = 90;

/**
 * Poster art, falling back to an initial tile when the catalog has no image
 * for the film or the image fails to load. The URL is built by the server, so
 * the client carries no knowledge of a provider's CDN.
 *
 * A poster downloads far more slowly than the text beside it, and a browser
 * keeps painting an `img` element's previous frame until the replacement has
 * decoded. Left alone that shows the last film's art under the next film's
 * title, which reads as the wrong movie rather than as a slow one. Two things
 * prevent it: the image is keyed by URL, so a new film mounts a new element
 * with nothing to hold over, and it stays hidden behind a spinner until it has
 * actually loaded.
 */
export function Poster({
  item,
  eager = false,
}: {
  item: CatalogItemDto;
  /** The card's poster is the primary content and must not be lazy. */
  eager?: boolean;
}) {
  const url = item.posterUrl;
  const [loadState, setLoadState] = useState<{
    url: string | null;
    loaded: boolean;
    failed: boolean;
  }>({ url, loaded: false, failed: false });

  // Reset during render rather than in an effect: an effect would run after
  // the browser had already painted one frame of the stale poster.
  if (loadState.url !== url) {
    setLoadState({ url, loaded: false, failed: false });
  }
  const stale = loadState.url !== url;
  const loaded = !stale && loadState.loaded;
  const failed = !stale && loadState.failed;

  if (url === null || failed) {
    return (
      <div className="poster placeholder" aria-hidden="true">
        {item.title.slice(0, 1)}
      </div>
    );
  }
  return (
    <div className="poster frame" aria-busy={!loaded}>
      {/*
        Decorative: the spinner says the artwork is on its way, and the image's
        own alt text carries the meaning once it arrives. Announcing it would
        also put a second live region beside the card's progress line.
      */}
      {loaded ? null : <span className="poster-spinner" aria-hidden="true" />}
      <img
        key={url}
        className={loaded ? 'poster-art is-loaded' : 'poster-art'}
        src={url}
        alt={`Poster for ${item.title}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onLoad={() => {
          setLoadState({ url, loaded: true, failed: false });
        }}
        onError={() => {
          setLoadState({ url, loaded: false, failed: true });
        }}
      />
    </div>
  );
}

/**
 * Swipe is one of three equal inputs: drag, the Yes/No buttons, and the arrow
 * keys. Nothing depends on gesture support.
 */
export function SwipeDeck({ card, round, busy, onChoice }: SwipeDeckProps) {
  const [offset, setOffset] = useState(0);
  const dragOrigin = useRef<number | null>(null);
  const choiceRef = useRef(onChoice);
  choiceRef.current = onChoice;

  useEffect(() => {
    setOffset(0);
  }, [card.exposureId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft') choiceRef.current('LEFT');
      if (event.key === 'ArrowRight') choiceRef.current('RIGHT');
    }
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function endDrag() {
    if (dragOrigin.current === null) return;
    dragOrigin.current = null;
    if (Math.abs(offset) >= DRAG_THRESHOLD_PX) {
      onChoice(offset > 0 ? 'RIGHT' : 'LEFT');
    }
    setOffset(0);
  }

  const progress = `Movie ${card.slatePosition.toString()} of ${card.slateSize.toString()}`;

  return (
    <section className="deck" aria-label="Voting card">
      {round === null || round.roundNumber === 1 ? null : (
        <p>
          <span className="round-tag">
            Round {round.roundNumber}
            {round.strategy === 'RECOMMENDED' ? ' · picked for your group' : ''}
          </span>
        </p>
      )}
      <p className="progress" role="status">
        {progress}
      </p>
      <article
        className="card"
        style={{
          transform: `translateX(${offset.toString()}px) rotate(${(offset / 24).toString()}deg)`,
        }}
        onPointerDown={(event) => {
          if (busy) return;
          dragOrigin.current = event.clientX;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragOrigin.current === null) return;
          setOffset(event.clientX - dragOrigin.current);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Poster item={card.item} eager />
        <div className="card-body">
          <h2>{card.item.title}</h2>
          <p className="meta">
            {[
              card.item.year?.toString(),
              card.item.runtimeMinutes === null
                ? null
                : `${card.item.runtimeMinutes.toString()} min`,
              card.item.contentRating,
            ]
              .filter((value) => value !== null && value !== undefined)
              .join(' · ')}
          </p>
          {card.item.genres.length === 0 ? null : (
            <ul className="genres" aria-label="Genres">
              {card.item.genres.map((genre) => (
                <li key={genre} className="chip">
                  {genre}
                </li>
              ))}
            </ul>
          )}
          <p className="synopsis">{card.item.synopsis}</p>
          {card.score === null && card.reason === null ? null : (
            <p className="pick">
              {card.score === null ? null : (
                <span className="pick-score">
                  {card.score}% predicted match
                </span>
              )}
              {card.reason === null ? null : (
                <span className="pick-reason">{card.reason}</span>
              )}
            </p>
          )}
        </div>
      </article>
      <div className="choices">
        <button
          type="button"
          className="no"
          disabled={busy}
          onClick={() => {
            onChoice('LEFT');
          }}
        >
          No
        </button>
        <button
          type="button"
          className="yes"
          disabled={busy}
          onClick={() => {
            onChoice('RIGHT');
          }}
        >
          Yes
        </button>
      </div>
      <p className="hint">
        Drag the card, use the buttons, or press the left and right arrow keys.
      </p>
    </section>
  );
}
