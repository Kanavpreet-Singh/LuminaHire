/**
 * Session-level aggregation across a mock interview's answers.
 *
 * Pure arithmetic, deliberately kept out of any LLM call — same rule as
 * python/scoring.py. A session score a candidate can't reproduce from their own
 * per-answer scores is a session score they can't trust, and self-comparison
 * across attempts is the only ranking this product does.
 */

export type AnswerScores = {
    score: number | null;
    scores: Record<string, number>;
};

export const DIMENSIONS = ["content", "language", "delivery", "presence"] as const;

/**
 * Mean per-answer overall, plus a per-dimension mean over whichever answers
 * actually carry that dimension.
 *
 * A dimension missing from an answer is SKIPPED, never counted as zero. A
 * TEXT-mode attempt has no delivery score at all, and an accessibility opt-out
 * removes delivery and presence — in both cases the dimension is absent, not
 * bad, and averaging a zero in would silently penalize exactly the people the
 * opt-out exists to protect.
 */
export function aggregateDimensions(answers: AnswerScores[]): {
    overall: number | null;
    dimensions: Record<string, number>;
} {
    const overalls = answers
        .map((a) => a.score)
        .filter((s): s is number => typeof s === "number" && Number.isFinite(s));

    const sums: Record<string, { total: number; count: number }> = {};
    for (const answer of answers) {
        for (const dim of DIMENSIONS) {
            const value = answer.scores?.[dim];
            if (typeof value !== "number" || !Number.isFinite(value)) continue;
            sums[dim] ??= { total: 0, count: 0 };
            sums[dim].total += value;
            sums[dim].count += 1;
        }
    }

    const dimensions: Record<string, number> = {};
    for (const [dim, { total, count }] of Object.entries(sums)) {
        if (count > 0) dimensions[dim] = round1(total / count);
    }

    return {
        overall: overalls.length > 0 ? round1(overalls.reduce((a, b) => a + b, 0) / overalls.length) : null,
        dimensions,
    };
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

/**
 * Delta between this session and the candidate's previous one, per dimension.
 * Returns only dimensions present in BOTH, since "you improved on delivery"
 * is meaningless if the previous attempt was text-only.
 */
export function scoreDelta(
    current: Record<string, number>,
    previous: Record<string, number> | null | undefined
): Record<string, number> {
    if (!previous) return {};
    const delta: Record<string, number> = {};
    for (const dim of DIMENSIONS) {
        if (typeof current[dim] === "number" && typeof previous[dim] === "number") {
            delta[dim] = round1(current[dim] - previous[dim]);
        }
    }
    return delta;
}
