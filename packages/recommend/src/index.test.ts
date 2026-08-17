import { describe, expect, it } from 'vitest';
import {
  buildProfiles,
  predict,
  scoreForGroup,
  selectRecommendedSlate,
  type Judgement,
  type TaggedItem,
} from './index.js';

function item(id: string, ...tags: string[]): TaggedItem {
  return { item: id, tags };
}

/** A pool big enough to pick 20 from, tagged across three genres. */
function pool(size: number, offset = 0): TaggedItem[] {
  return Array.from({ length: size }, (_, index) => {
    const n = index + offset;
    return item(
      `c${n.toString()}`,
      `genre:${(n % 3).toString()}`,
      `decade:${(1980 + (n % 4) * 10).toString()}`,
    );
  });
}

describe('buildProfiles', () => {
  const judged = [
    item('a', 'genre:action', 'decade:1990'),
    item('b', 'genre:action', 'decade:2000'),
    item('c', 'genre:romance', 'decade:1990'),
  ];

  it('scores a consistently liked tag positive and a disliked one negative', () => {
    const [profile] = buildProfiles(
      [
        { participant: 'p1', item: 'a', liked: true },
        { participant: 'p1', item: 'b', liked: true },
        { participant: 'p1', item: 'c', liked: false },
      ],
      judged,
    );
    expect(profile?.affinity.get('genre:action') ?? 0).toBeGreaterThan(0);
    expect(profile?.affinity.get('genre:romance') ?? 0).toBeLessThan(0);
    expect(profile?.sampleSize).toBe(3);
  });

  it('smooths a single swipe toward neutral rather than certainty', () => {
    const [profile] = buildProfiles(
      [{ participant: 'p1', item: 'a', liked: true }],
      judged,
    );
    const affinity = profile?.affinity.get('genre:action') ?? 0;
    expect(affinity).toBeGreaterThan(0);
    // One yes must not read as total confidence.
    expect(affinity).toBeLessThan(0.5);
  });

  it('lets repeated evidence outweigh a single swipe', () => {
    const one = buildProfiles(
      [{ participant: 'p1', item: 'a', liked: true }],
      judged,
    );
    const many = buildProfiles(
      [
        { participant: 'p1', item: 'a', liked: true },
        { participant: 'p1', item: 'b', liked: true },
      ],
      judged,
    );
    expect(many[0]?.affinity.get('genre:action') ?? 0).toBeGreaterThan(
      one[0]?.affinity.get('genre:action') ?? 0,
    );
  });

  it('weights a dislike less than a like', () => {
    const [liked] = buildProfiles(
      [{ participant: 'p1', item: 'a', liked: true }],
      judged,
    );
    const [disliked] = buildProfiles(
      [{ participant: 'p1', item: 'a', liked: false }],
      judged,
    );
    const up = liked?.affinity.get('genre:action') ?? 0;
    const down = disliked?.affinity.get('genre:action') ?? 0;
    expect(up).toBeGreaterThan(Math.abs(down));
  });

  it('keeps participants separate', () => {
    const profiles = buildProfiles(
      [
        { participant: 'p1', item: 'a', liked: true },
        { participant: 'p2', item: 'a', liked: false },
      ],
      judged,
    );
    expect(profiles).toHaveLength(2);
    expect(profiles[0]?.affinity.get('genre:action') ?? 0).toBeGreaterThan(0);
    expect(profiles[1]?.affinity.get('genre:action') ?? 0).toBeLessThan(0);
  });

  it('ignores a judgement on an item it has no tags for', () => {
    const profiles = buildProfiles(
      [{ participant: 'p1', item: 'unknown', liked: true }],
      judged,
    );
    expect(profiles).toEqual([]);
  });
});

describe('predict', () => {
  const judged = [item('a', 'genre:action')];
  const profile = buildProfiles(
    [{ participant: 'p1', item: 'a', liked: true }],
    judged,
  )[0] ?? {
    participant: 'p1',
    affinity: new Map<string, number>(),
    sampleSize: 0,
  };

  it('treats an unknown item as neutral, not unwanted', () => {
    expect(predict(profile, item('x', 'genre:unseen'))).toBe(0.5);
    expect(predict(profile, item('y'))).toBe(0.5);
  });

  it('scores a liked tag above neutral', () => {
    expect(predict(profile, item('x', 'genre:action'))).toBeGreaterThan(0.5);
  });

  it('stays within [0, 1]', () => {
    const strong = buildProfiles(
      Array.from({ length: 20 }, () => ({
        participant: 'p1',
        item: 'a',
        liked: true,
      })),
      judged,
    );
    const strongest = strong[0] ?? profile;
    const value = predict(strongest, item('x', 'genre:action'));
    expect(value).toBeGreaterThan(0.5);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('scoreForGroup', () => {
  const judged = [item('a', 'genre:action'), item('b', 'genre:horror')];
  const judgements: Judgement[] = [
    { participant: 'fan', item: 'a', liked: true },
    { participant: 'fan', item: 'b', liked: true },
    { participant: 'hater', item: 'a', liked: true },
    { participant: 'hater', item: 'b', liked: false },
  ];
  const profiles = buildProfiles(judgements, judged);

  it('is neutral with nobody to score for', () => {
    expect(scoreForGroup([], item('x', 'genre:action'))).toMatchObject({
      score: 0.5,
      supporters: 0,
    });
  });

  it('penalises an item one member clearly does not want', () => {
    const agreed = scoreForGroup(profiles, item('x', 'genre:action'));
    const contested = scoreForGroup(profiles, item('y', 'genre:horror'));
    expect(agreed.score).toBeGreaterThan(contested.score);
    expect(contested.worst).toBeLessThan(agreed.worst);
  });

  it('least-misery weighting punishes a split more than averaging does', () => {
    const contested = item('y', 'genre:horror');
    const average = scoreForGroup(profiles, contested, {
      consensusWeight: 1,
    }).score;
    const misery = scoreForGroup(profiles, contested, {
      consensusWeight: 0,
    }).score;
    expect(misery).toBeLessThan(average);
  });

  it('counts supporters above the enthusiasm threshold', () => {
    const result = scoreForGroup(profiles, item('x', 'genre:action'));
    expect(result.supporters).toBe(2);
  });
});

describe('selectRecommendedSlate', () => {
  const judged = [item('a', 'genre:0'), item('b', 'genre:1')];
  const judgements: Judgement[] = [
    { participant: 'p1', item: 'a', liked: true },
    { participant: 'p1', item: 'b', liked: false },
    { participant: 'p2', item: 'a', liked: true },
    { participant: 'p2', item: 'b', liked: false },
  ];
  const options = { size: 20, seed: 'seed-a' };

  it('fills the slate without repeats', () => {
    const slate = selectRecommendedSlate(judgements, judged, pool(60), options);
    expect(slate).toHaveLength(20);
    expect(new Set(slate.map((entry) => entry.item)).size).toBe(20);
    expect(slate.map((entry) => entry.position)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const first = selectRecommendedSlate(judgements, judged, pool(60), options);
    const again = selectRecommendedSlate(judgements, judged, pool(60), options);
    const other = selectRecommendedSlate(judgements, judged, pool(60), {
      ...options,
      seed: 'seed-b',
    });
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('reserves exploration slots and marks them honestly', () => {
    const slate = selectRecommendedSlate(judgements, judged, pool(60), {
      ...options,
      explorationSlots: 5,
    });
    expect(slate.filter((entry) => entry.exploration)).toHaveLength(5);
    for (const entry of slate.filter((item) => item.exploration)) {
      expect(entry.topTags).toEqual([]);
      expect(entry.supporters).toBe(0);
    }
  });

  it('honours a diversity cap on the scored picks', () => {
    const slate = selectRecommendedSlate(judgements, judged, pool(60), {
      ...options,
      explorationSlots: 0,
      maxPerFacet: 3,
    });
    const counts = new Map<string, number>();
    for (const entry of slate) {
      const facet = pool(60).find((candidate) => candidate.item === entry.item)
        ?.tags[0];
      if (facet !== undefined) {
        counts.set(facet, (counts.get(facet) ?? 0) + 1);
      }
    }
    // Three genres, cap of three each, so the cap must have been relaxed to
    // fill twenty — but no genre may run away with the whole slate.
    expect(Math.max(...counts.values())).toBeLessThan(20);
  });

  it('prefers what the group liked over what it rejected', () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, index) =>
        item(`liked${index.toString()}`, 'genre:0'),
      ),
      ...Array.from({ length: 15 }, (_, index) =>
        item(`hated${index.toString()}`, 'genre:1'),
      ),
    ];
    const slate = selectRecommendedSlate(judgements, judged, candidates, {
      ...options,
      explorationSlots: 0,
      maxPerFacet: 20,
    });
    const liked = slate.filter((entry) => entry.item.startsWith('liked'));
    expect(liked).toHaveLength(15);
  });

  it('explains a scored pick with the tags that drove it', () => {
    const slate = selectRecommendedSlate(judgements, judged, pool(60), {
      ...options,
      explorationSlots: 0,
    });
    const scored = slate.find((entry) => entry.topTags.length > 0);
    expect(scored?.topTags[0]).toBe('genre:0');
  });

  it('still produces a slate with no judgements at all', () => {
    const slate = selectRecommendedSlate([], [], pool(30), options);
    expect(slate).toHaveLength(20);
  });

  it('refuses a slate it cannot fill', () => {
    expect(() =>
      selectRecommendedSlate(judgements, judged, pool(5), options),
    ).toThrow(/Need 20 candidates/u);
  });

  it('rejects a nonsensical size', () => {
    expect(() =>
      selectRecommendedSlate(judgements, judged, pool(60), {
        ...options,
        size: 0,
      }),
    ).toThrow(/positive integer/u);
  });

  it('caps exploration at the slate size', () => {
    const slate = selectRecommendedSlate(judgements, judged, pool(60), {
      ...options,
      explorationSlots: 999,
    });
    expect(slate).toHaveLength(20);
    expect(slate.every((entry) => entry.exploration)).toBe(true);
  });
});
