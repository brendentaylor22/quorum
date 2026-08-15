import type { CatalogItemDto, ExposureCard } from '@quorum/contracts';
import { useEffect, useRef, useState } from 'react';

interface SwipeDeckProps {
  card: ExposureCard;
  busy: boolean;
  onChoice: (choice: 'LEFT' | 'RIGHT') => void;
}

const DRAG_THRESHOLD_PX = 90;

/**
 * Poster art, falling back to an initial tile when the catalog has no image
 * for the film or the image fails to load. The URL is built by the server, so
 * the client carries no knowledge of a provider's CDN.
 */
export function Poster({
  item,
  eager = false,
}: {
  item: CatalogItemDto;
  /** The card's poster is the primary content and must not be lazy. */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (item.posterUrl === null || failed) {
    return (
      <div className="poster" aria-hidden="true">
        {item.title.slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      className="poster art"
      src={item.posterUrl}
      alt={`Poster for ${item.title}`}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

/**
 * Swipe is one of three equal inputs: drag, the Yes/No buttons, and the arrow
 * keys. Nothing depends on gesture support.
 */
export function SwipeDeck({ card, busy, onChoice }: SwipeDeckProps) {
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
        <p className="synopsis">{card.item.synopsis}</p>
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
