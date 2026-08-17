import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rankSlate, type RankingTally } from './index.js';

interface ExampleInput {
  item: string;
  slate_position: number;
  yes: number;
  responses: number;
}

interface ExampleExpectation {
  rank: number;
  item: string;
  approval_pct: number;
  coverage_pct: number;
  yes_fraction: string;
  match: boolean;
}

interface Example {
  name: string;
  eligible: number;
  input: ExampleInput[];
  expected: ExampleExpectation[];
}

const contractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/contracts/ranking.examples.json',
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  contract: string;
  examples: Example[];
};

function toTallies(input: ExampleInput[]): RankingTally[] {
  return input.map((row) => ({
    item: row.item,
    slatePosition: row.slate_position,
    yes: row.yes,
    responses: row.responses,
  }));
}

describe('rankSlate against the normative contract examples', () => {
  it('uses the quorum-ranking-v1 contract', () => {
    expect(contract.contract).toBe('quorum-ranking-v1');
    expect(contract.examples.length).toBeGreaterThan(0);
  });

  for (const example of contract.examples) {
    it(example.name, () => {
      const ranked = rankSlate(example.eligible, toTallies(example.input));
      expect(
        ranked.map((row) => ({
          rank: row.rank,
          item: row.item,
          approval_pct: row.approvalPct,
          coverage_pct: row.coveragePct,
          yes_fraction: row.yesFraction,
          match: row.match,
        })),
      ).toEqual(example.expected);
    });
  }
});

describe('rankSlate properties', () => {
  const slate = (yes: number[], responses: number[]): RankingTally[] =>
    yes.map((value, index) => ({
      item: `item-${index.toString()}`,
      slatePosition: index + 1,
      yes: value,
      responses: responses[index] ?? value,
    }));

  it('keeps percentages within 0 to 100', () => {
    const ranked = rankSlate(4, slate([0, 1, 2, 3, 4], [4, 4, 4, 4, 4]));
    for (const row of ranked) {
      expect(row.approvalPct).toBeGreaterThanOrEqual(0);
      expect(row.approvalPct).toBeLessThanOrEqual(100);
      expect(row.coveragePct).toBeGreaterThanOrEqual(0);
      expect(row.coveragePct).toBeLessThanOrEqual(100);
    }
  });

  it('flags unanimous approval only when every eligible participant said yes', () => {
    const ranked = rankSlate(3, slate([3, 2], [3, 2]));
    expect(ranked[0]?.match).toBe(true);
    expect(ranked[1]?.match).toBe(false);
  });

  it('does not let non-responses inflate approval after an early close', () => {
    const ranked = rankSlate(4, slate([1], [1]));
    expect(ranked[0]?.approvalPct).toBe(25);
    expect(ranked[0]?.coveragePct).toBe(25);
    expect(ranked[0]?.match).toBe(false);
  });

  it('breaks presentation ties by slate position without changing rank', () => {
    const ranked = rankSlate(4, [
      { item: 'late', slatePosition: 9, yes: 2, responses: 4 },
      { item: 'early', slatePosition: 2, yes: 2, responses: 4 },
    ]);
    expect(ranked.map((row) => row.item)).toEqual(['early', 'late']);
    expect(ranked.map((row) => row.rank)).toEqual([1, 1]);
  });

  it('is deterministic for repeated input orderings', () => {
    const tallies = slate([2, 2, 1], [4, 4, 4]);
    const forward = rankSlate(4, tallies);
    const reversed = rankSlate(4, [...tallies].reverse());
    expect(reversed).toEqual(forward);
  });

  it('ranks coverage above an equal-approval item with fewer responses', () => {
    const ranked = rankSlate(4, [
      { item: 'thin', slatePosition: 1, yes: 1, responses: 1 },
      { item: 'covered', slatePosition: 2, yes: 1, responses: 3 },
    ]);
    expect(ranked.map((row) => row.item)).toEqual(['covered', 'thin']);
    expect(ranked.map((row) => row.rank)).toEqual([1, 2]);
  });

  it('rejects impossible tallies and empty eligibility', () => {
    expect(() => rankSlate(0, [])).toThrow(/eligible participant/u);
    expect(() =>
      rankSlate(2, [{ item: 'a', slatePosition: 1, yes: 3, responses: 3 }]),
    ).toThrow(/exceed eligible/u);
    expect(() =>
      rankSlate(2, [{ item: 'a', slatePosition: 1, yes: 2, responses: 1 }]),
    ).toThrow(/exceed responses/u);
    expect(() =>
      rankSlate(2, [{ item: 'a', slatePosition: 1, yes: -1, responses: 1 }]),
    ).toThrow(/negative/u);
    expect(() =>
      rankSlate(2, [{ item: 'a', slatePosition: 1, yes: 0.5, responses: 1 }]),
    ).toThrow(/integral/u);
  });
});
