import type { CatalogSource, InstanceInfo } from '@quorum/contracts';
import tmdbLogo from '../assets/tmdb-primary-short.svg';

/**
 * The privacy notice.
 *
 * Written as plain sentences rather than a policy, because the honest version
 * is short: Quorum has no accounts, no analytics, and nothing to sell. What it
 * does keep, it keeps briefly, and this page says exactly what and for how
 * long. The one thing it cannot promise is what a given operator's network
 * provider sees, so it says that too rather than implying otherwise.
 */
export function PrivacyScreen({
  catalog,
  instance,
}: {
  catalog: CatalogSource | null;
  instance: InstanceInfo | null;
}) {
  return (
    <section className="prose">
      <h2>What Quorum knows about you</h2>

      <p>
        No account, no email, no password, no profile. Quorum never asks who you
        are, and has no way to find out.
      </p>

      <h3>What is stored while a room is running</h3>
      <ul>
        <li>
          <strong>The display name you typed.</strong> It exists to tell people
          in one room apart. Nothing checks it, and nothing links it to a name
          you used in another room.
        </li>
        <li>
          <strong>Your votes,</strong> as a yes or no against each film, with
          the time each was confirmed. Nobody sees them while voting is open —
          not the host, not the server operator through the app.
        </li>
        <li>
          <strong>A session cookie,</strong> scoped to that one room. It is how
          the server knows which votes are yours when you refresh. It grants
          nothing outside that room and expires with it.
        </li>
        <li>
          <strong>Room events</strong> such as created, started, and closed,
          with timestamps, so problems can be diagnosed.
        </li>
      </ul>

      <h3>How long it lasts</h3>
      <p>
        A room in the lobby expires 24 hours after it was created, and 24 hours
        after voting starts. A finished room lasts 7 days so people can look at
        the result again. Once a room expires it is deleted a day later — the
        room, the names, the votes, all of it — by a job that runs whether or
        not anyone visits.
      </p>
      <p>
        Deleting from the live service is not the same as deleting from backups.
        An operator who takes backups will still hold a copy until those backups
        age out. Ask the person running this instance what their backup schedule
        is; Quorum cannot answer that for them.
      </p>

      <h3>What is never collected</h3>
      <p>
        No analytics, no advertising, no trackers, no third-party scripts of any
        kind. No contact list, no location, no device fingerprint. No profile
        that follows you from one room to the next — history is deliberately
        room-scoped, and there is no mechanism to join it up.
      </p>

      <h3>Who else sees anything</h3>
      <ul>
        {catalog?.attribution === null ? null : (
          <li>
            <strong>TMDB</strong> serves the poster images. Your browser fetches
            them directly, so TMDB sees that a request for a poster came from
            your network. Quorum sends no referrer, so it does not learn which
            room you are in.
          </li>
        )}
        <li>
          <strong>Whoever runs this instance,</strong> and their hosting and
          network providers. Quorum is self-hosted software; the operator has
          access to the server it runs on. That is true of every website, and is
          worth stating plainly rather than leaving implied.
        </li>
      </ul>

      <h3>Anyone with the link</h3>
      <p>
        A room is protected by an unguessable link, not by a password. Anyone
        who has the invite can join and vote. That is the trade for needing no
        account — treat the link the way you would treat the room itself.
      </p>

      {catalog?.attribution == null ? null : (
        <>
          <h3>Where the movie data comes from</h3>
          <p>
            Titles, synopses, and poster images come from TMDB. Quorum is not
            affiliated with them, and this page is where that is recorded rather
            than only in a footer line.
          </p>
          <p>{catalog.attribution}</p>
          {/*
            TMDB's terms require the logo be shown unmodified and less
            prominently than Quorum's own branding, so it is sized well below
            the page heading and carries no styling beyond that. It renders only
            when a TMDB catalogue is installed — a fixture-only instance uses no
            TMDB data and shows no TMDB branding. Provenance and the rules this
            asset is used under: `apps/web/src/assets/README.md`.
          */}
          <a
            className="provider-logo"
            href="https://www.themoviedb.org"
            rel="noreferrer noopener"
          >
            <img src={tmdbLogo} alt="The Movie Database (TMDB)" />
          </a>
        </>
      )}

      {instance === null ? null : (
        <>
          <h3>The software</h3>
          <p>
            Quorum is free software licensed under {instance.licence}. You are
            entitled to its source:{' '}
            <a href={instance.sourceUrl} rel="noreferrer noopener">
              {instance.sourceUrl}
            </a>
            {instance.modified
              ? '. The operator of this instance has pointed this link at their own copy, which may differ from the original.'
              : '.'}
          </p>
        </>
      )}

      <p className="hint">
        <a href="/">Back to Quorum</a>
      </p>
    </section>
  );
}
