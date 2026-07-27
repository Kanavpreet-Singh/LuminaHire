"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { verdict } from "@/lib/verdict";
import {
    Page,
    PageHeader,
    Card,
    Section,
    Stat,
    EmptyState,
    ErrorNote,
    Loading,
    LinkButton,
    cx,
} from "@/components/ui";

/**
 * Calibration: how the pipeline's rulings held up in real interviews.
 *
 * The only view in the product that scores the product itself. It reads the
 * ratings recruiters write into interview kits and compares each against the
 * verdict that question was probing.
 */

type StatusRow = {
    status: string;
    label: string;
    count: number;
    meanRating: number;
    strongShare: number;
    weakShare: number;
};

type Calibration = {
    totalRated: number;
    byStatus: StatusRow[];
    contradictionsAnsweredWell: {
        sessionId: string;
        candidate: string;
        claimId: string | null;
        rating: number;
        notes: string | null;
    }[];
    sampleSufficient: boolean;
    falseContradictionRate: number | null;
};

export default function CalibrationPage() {
    const [data, setData] = useState<Calibration | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/kit/calibration")
            .then(async (res) => {
                if (!res.ok) throw new Error(await res.text());
                return res.json();
            })
            .then(setData)
            .catch((e) => setError(e.message || "Couldn't load calibration"))
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return (
            <Page>
                <Loading label="Reading your interview notes…" />
            </Page>
        );
    }
    if (error) {
        return (
            <Page>
                <ErrorNote>{error}</ErrorNote>
            </Page>
        );
    }
    if (!data) return null;

    return (
        <Page>
            <PageHeader
                backHref="/vetting"
                backLabel="Sessions"
                eyebrow="Is the verification right?"
                title="Calibration"
                description="How résumé rulings held up once you asked in person. Built from the ratings you write into interview kits, so it sharpens as you run interviews."
            />

            {data.totalRated === 0 ? (
                <EmptyState
                    title="No rated answers yet"
                    description="Rate answers in an interview kit during your next interview. This page then shows whether the automated verdicts matched what you found in the room."
                    action={<LinkButton href="/vetting">Open a session</LinkButton>}
                />
            ) : (
                <div className="space-y-8">
                    {!data.sampleSufficient && (
                        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-400">
                            <strong className="tabular-nums">{data.totalRated}</strong> rated{" "}
                            {data.totalRated === 1 ? "answer" : "answers"} so far. Read these as individual
                            cases, not rates — there isn&apos;t enough here to draw a trend from yet.
                        </div>
                    )}

                    <Section
                        title="How each kind of claim interviewed"
                        description="Mean interviewer rating, 1–5, grouped by what the pipeline had ruled."
                    >
                        <Card className="overflow-x-auto">
                            <table className="w-full min-w-152 border-collapse text-sm">
                                <thead>
                                    <tr className="border-b border-border-default text-left text-[10px] uppercase tracking-[0.12em] text-content-tertiary">
                                        <th className="pb-3 font-bold">Ruling</th>
                                        <th className="pb-3 text-right font-bold">Asked</th>
                                        <th className="pb-3 text-right font-bold">Mean</th>
                                        <th className="pb-3 pl-6 font-bold">Answered well (4–5)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.byStatus.map((row) => {
                                        const v = verdict(row.status);
                                        return (
                                            <tr
                                                key={row.status}
                                                className="border-b border-border-default/60 last:border-0"
                                            >
                                                <td className="py-4 pr-4">
                                                    <span
                                                        className={cx(
                                                            "inline-flex items-center rounded-lg border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]",
                                                            v.pill
                                                        )}
                                                    >
                                                        {row.status}
                                                    </span>
                                                    <span className="mt-1 block max-w-xs text-xs text-content-tertiary">
                                                        {row.label}
                                                    </span>
                                                </td>
                                                <td className="py-4 text-right tabular-nums text-content-secondary">
                                                    {row.count}
                                                </td>
                                                <td className="py-4 text-right text-base font-bold tabular-nums text-content-primary">
                                                    {row.meanRating.toFixed(1)}
                                                </td>
                                                <td className="py-4 pl-6">
                                                    <div className="flex items-center gap-3">
                                                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-tertiary">
                                                            <div
                                                                className={cx("h-full rounded-full", v.solid)}
                                                                style={{ width: `${row.strongShare * 100}%` }}
                                                            />
                                                        </div>
                                                        <span className="text-xs tabular-nums text-content-secondary">
                                                            {Math.round(row.strongShare * 100)}%
                                                        </span>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </Card>
                    </Section>

                    {data.falseContradictionRate !== null && (
                        <Section title="Contradictions that answered well">
                            <Card className="space-y-4">
                                <div className="flex flex-wrap items-end gap-6">
                                    <Stat
                                        value={`${Math.round(data.falseContradictionRate * 100)}%`}
                                        label="answered convincingly"
                                        tone={data.falseContradictionRate > 0.5 ? "down" : undefined}
                                    />
                                    <p className="max-w-xl flex-1 text-sm leading-relaxed text-content-secondary">
                                        Worth chasing when it&apos;s high. Either candidates are explaining stale
                                        figures well — profiles do go out of date — or the ruling was wrong. A
                                        false contradiction is the most damaging thing this system can output,
                                        so read these individually.
                                    </p>
                                </div>

                                {data.contradictionsAnsweredWell.length > 0 && (
                                    <ul className="space-y-2 border-t border-border-default pt-4">
                                        {data.contradictionsAnsweredWell.map((c, i) => (
                                            <li
                                                key={i}
                                                className="rounded-xl border border-border-default bg-surface-secondary/60 p-3"
                                            >
                                                <div className="flex flex-wrap items-baseline gap-2">
                                                    <Link
                                                        href={`/vetting/${c.sessionId}`}
                                                        className="text-sm font-bold text-content-primary no-underline hover:text-primary-300"
                                                    >
                                                        {c.candidate}
                                                    </Link>
                                                    <span className="text-xs tabular-nums text-content-tertiary">
                                                        {c.claimId} · rated {c.rating}/5
                                                    </span>
                                                </div>
                                                {c.notes && (
                                                    <p className="mt-1 text-xs text-content-secondary">
                                                        {c.notes}
                                                    </p>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </Card>
                        </Section>
                    )}

                    <Card tone="quiet">
                        <h2 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                            Reading this
                        </h2>
                        <p className="text-sm leading-relaxed text-content-secondary">
                            The bet this product makes is that a claim no public source can settle is usually
                            just private work, and so should never cost a candidate points. If{" "}
                            <span className={verdict("UNVERIFIABLE").text}>unverifiable</span> claims interview
                            about as well as <span className={verdict("VERIFIED").text}>verified</span> ones,
                            that bet is holding. If they interview much worse, treating them as neutral is too
                            generous and the scoring deserves another look.
                        </p>
                    </Card>
                </div>
            )}
        </Page>
    );
}
