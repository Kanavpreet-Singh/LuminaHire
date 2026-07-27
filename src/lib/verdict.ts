/**
 * The canonical visual vocabulary for claim rulings.
 *
 * This product's distinctive content is verdicts: every résumé claim comes back
 * VERIFIED, CONTRADICTED, UNVERIFIABLE, or UNCHECKED, and a recruiter reads
 * dozens of them across the session page, the interview kit, and calibration.
 * Before this file each surface invented its own colours, so the same ruling
 * looked different depending on where you met it — which makes a four-word
 * vocabulary something you have to re-learn on every screen instead of
 * something you absorb once.
 *
 * One definition, used everywhere.
 *
 * THE COLOUR ASSIGNMENTS ARE ARGUMENTS, NOT DECORATION:
 *
 *   VERIFIED      emerald — evidence backs it. The only positive.
 *   CONTRADICTED  rose    — the candidate's own linked profile disagrees. The
 *                           highest-value and most damaging finding, so it is
 *                           the only alarming colour in the set.
 *   UNVERIFIABLE  slate   — deliberately NEUTRAL, never amber. Most good
 *                           engineers do their best work in private repos;
 *                           colouring this as a warning would train recruiters
 *                           to read "normal job" as "concern", which is exactly
 *                           the bias the scoring rules were written to avoid.
 *   UNCHECKED     amber   — a gap in OUR coverage, not in the candidate. Amber
 *                           because someone should go look, not because the
 *                           candidate did anything.
 */

export type ClaimStatus = "VERIFIED" | "CONTRADICTED" | "UNVERIFIABLE" | "UNCHECKED";

export type VerdictStyle = {
    /**
     * Plain-language label, NOT the raw enum. "Not publicly checkable" tells a
     * recruiter what happened; "UNVERIFIABLE" makes them guess, and the wrong
     * guess ("we couldn't verify them") is exactly the misreading that would
     * penalize candidates whose work is private.
     */
    label: string;
    /** One line a recruiter can read without prior training. */
    blurb: string;
    /** Tailwind classes for a pill: background, text, border. */
    pill: string;
    /** Text-only colour, for inline emphasis. */
    text: string;
    /** Solid colour for bars and dots. */
    solid: string;
};

export const VERDICTS: Record<ClaimStatus, VerdictStyle> = {
    VERIFIED: {
        label: "Verified",
        blurb: "Confirmed against a profile the candidate linked.",
        pill: "bg-emerald-500/10 text-emerald-300 border-emerald-400/30",
        text: "text-emerald-400",
        solid: "bg-emerald-500",
    },
    CONTRADICTED: {
        label: "Contradicted",
        blurb: "The candidate's own linked profile conflicts with this claim.",
        pill: "bg-rose-500/10 text-rose-300 border-rose-400/30",
        text: "text-rose-400",
        solid: "bg-rose-500",
    },
    UNVERIFIABLE: {
        label: "Not publicly checkable",
        blurb: "Normal for private or internal work — ask about it in the interview.",
        pill: "bg-slate-500/10 text-slate-300 border-slate-400/30",
        text: "text-content-secondary",
        solid: "bg-slate-400",
    },
    UNCHECKED: {
        label: "Could not read source",
        blurb: "A relevant link exists but couldn't be read automatically — open it manually.",
        pill: "bg-amber-500/10 text-amber-300 border-amber-400/30",
        text: "text-amber-400",
        solid: "bg-amber-500",
    },
};

const FALLBACK: VerdictStyle = {
    label: "No ruling",
    blurb: "No ruling was recorded for this claim.",
    pill: "bg-surface-secondary text-content-tertiary border-border-default",
    text: "text-content-tertiary",
    solid: "bg-slate-600",
};

export function verdict(status: string | null | undefined): VerdictStyle {
    if (!status) return FALLBACK;
    return VERDICTS[status.toUpperCase() as ClaimStatus] ?? FALLBACK;
}

/**
 * Verdict order for display: the ones that change a decision first.
 * A recruiter with two minutes should meet the contradictions before anything
 * else, and the verified claims last — those are the ones needing no action.
 */
export const VERDICT_ORDER: ClaimStatus[] = [
    "CONTRADICTED",
    "UNCHECKED",
    "UNVERIFIABLE",
    "VERIFIED",
];

export function sortByVerdict<T>(items: T[], statusOf: (item: T) => string | null | undefined): T[] {
    const rank = (s: string | null | undefined) => {
        const i = VERDICT_ORDER.indexOf((s || "").toUpperCase() as ClaimStatus);
        return i === -1 ? VERDICT_ORDER.length : i;
    };
    return [...items].sort((a, b) => rank(statusOf(a)) - rank(statusOf(b)));
}
