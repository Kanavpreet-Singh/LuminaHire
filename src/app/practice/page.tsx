"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { scoreDelta } from "@/lib/mock-score";
import {
    Page,
    Section,
    Card,
    Badge,
    EmptyState,
    ErrorNote,
    Loading,
    LinkButton,
    cx,
} from "@/components/ui";

/**
 * Practice Studio home: pick a role to rehearse for, and revisit past sessions.
 *
 * Everything here is candidate-owned. Nothing reaches a recruiter unless the
 * candidate shares it, and even then only content scores travel.
 *
 * DESIGN NOTE. The hero is a waveform, not a stat tile. This product's whole
 * thesis is that it measures how you actually spoke — pace, pauses, expression
 * — not just what you typed, and the page should say that before it says
 * anything else. Everything past the hero stays deliberately quiet: the
 * signature move is spent once, here.
 */

interface Job {
    id: string;
    title: string;
    companyName: string;
    status: string;
}

interface MockInterview {
    id: string;
    status: string;
    mode: string;
    overallScore: number | null;
    dimensionScores: Record<string, number> | null;
    startedAt: string;
    completedAt: string | null;
    job: { id: string; title: string };
    _count: { answers: number };
}

export default function PracticeHomePage() {
    const { data: session, status } = useSession();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [interviews, setInterviews] = useState<MockInterview[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const isCandidate = (session?.user as any)?.role === "CANDIDATE";

    useEffect(() => {
        if (status !== "authenticated") {
            if (status === "unauthenticated") setLoading(false);
            return;
        }
        (async () => {
            try {
                const [jobsRes, mocksRes] = await Promise.all([
                    fetch("/api/jobs?query="),
                    isCandidate ? fetch("/api/mock") : Promise.resolve(null),
                ]);
                if (jobsRes.ok) setJobs(await jobsRes.json());
                if (mocksRes?.ok) setInterviews((await mocksRes.json()).interviews || []);
            } catch {
                setError("Couldn't load the practice studio. Refresh to try again.");
            } finally {
                setLoading(false);
            }
        })();
    }, [status, isCandidate]);

    if (status === "loading" || loading) {
        return (
            <Page>
                <Loading label="Loading your practice…" />
            </Page>
        );
    }

    if (status !== "authenticated") {
        return (
            <Page width="narrow">
                <EmptyState
                    title="Sign in to practise"
                    description="Practice sessions are private to your account, so you'll need to be signed in."
                    action={<LinkButton href="/login" tone="primary">Log in</LinkButton>}
                />
            </Page>
        );
    }

    const openJobs = jobs.filter((j) => j.status === "OPEN");
    const completed = interviews
        .filter((m) => m.status === "COMPLETED" && typeof m.overallScore === "number")
        .slice()
        .reverse(); // oldest first, so the trend reads left to right

    return (
        <Page>
            <Hero />

            <div className="space-y-10">
                {/* Your own trend. The ONLY comparison this product makes — no
                    cohort, no percentile. A percentile on these metrics would be a
                    percentile on accent, home acoustics, and webcam quality. */}
                {completed.length >= 2 && <ProgressTrend sessions={completed} />}

                {error && <ErrorNote>{error}</ErrorNote>}

                {interviews.length > 0 && (
                    <Section title="Your sessions">
                        <div className="space-y-3">
                            {interviews.map((mock, i) => (
                                <SessionRow key={mock.id} mock={mock} delay={i} />
                            ))}
                        </div>
                    </Section>
                )}

                <Section
                    title="Start a session"
                    description="Questions are written from the job posting, so they're the same for every applicant."
                >
                    {openJobs.length === 0 ? (
                        <EmptyState
                            title="No open roles to practise against"
                            description="When a company posts a role, its practice questions are written automatically and appear here."
                            action={<LinkButton href="/jobs">Browse jobs</LinkButton>}
                        />
                    ) : (
                        <div className="grid gap-3 sm:grid-cols-2">
                            {openJobs.map((job, i) => (
                                <Link
                                    key={job.id}
                                    href={`/practice/${job.id}`}
                                    style={{ animationDelay: `${i * 40}ms` }}
                                    className="q-enter group relative overflow-hidden rounded-2xl border border-border-default bg-surface-card p-5 no-underline shadow-md transition-all hover:-translate-y-px hover:border-primary-400/40 hover:shadow-glow"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-content-primary">{job.title}</p>
                                            <p className="mt-1 text-xs text-content-tertiary">{job.companyName}</p>
                                        </div>
                                        <span
                                            aria-hidden="true"
                                            className="mt-0.5 shrink-0 text-content-tertiary transition-all group-hover:translate-x-0.5 group-hover:text-primary-400"
                                        >
                                            →
                                        </span>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )}
                </Section>
            </div>
        </Page>
    );
}

/**
 * The hero. A voice waveform rendered in CSS, not a photo of one — each bar
 * animates on its own loop so the shape never repeats. It sits directly
 * behind the word "spoke" in the headline, so the visual and the claim land
 * in the same glance.
 */
function Hero() {
    // Heights and per-bar timing are hand-set, not randomized, so the shape
    // reads as a considered waveform rather than noise.
    const bars = [
        { h: 0.35, min: 0.2, max: 0.9, dur: 1.7, delay: 0.0 },
        { h: 0.55, min: 0.3, max: 1.0, dur: 1.3, delay: 0.15 },
        { h: 0.8, min: 0.25, max: 1.0, dur: 1.9, delay: 0.05 },
        { h: 0.45, min: 0.35, max: 0.85, dur: 1.4, delay: 0.3 },
        { h: 0.95, min: 0.4, max: 1.0, dur: 1.6, delay: 0.1 },
        { h: 0.6, min: 0.2, max: 0.95, dur: 2.1, delay: 0.2 },
        { h: 0.4, min: 0.3, max: 0.8, dur: 1.5, delay: 0.4 },
        { h: 0.75, min: 0.3, max: 1.0, dur: 1.8, delay: 0.0 },
        { h: 0.5, min: 0.25, max: 0.9, dur: 1.3, delay: 0.25 },
        { h: 0.3, min: 0.2, max: 0.7, dur: 1.6, delay: 0.35 },
    ];

    return (
        <header className="relative mb-10 overflow-hidden rounded-3xl border border-border-default bg-surface-card px-6 py-10 shadow-md sm:px-10 sm:py-14">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.12)_0%,transparent_70%)] blur-2xl"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.10)_0%,transparent_70%)] blur-2xl"
            />

            <p className="q-enter relative text-[10px] font-bold uppercase tracking-[0.2em] text-content-tertiary">
                Private to you
            </p>

            <div className="relative mt-3 flex flex-wrap items-end gap-x-4 gap-y-6">
                <h1
                    className="q-enter font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-content-primary sm:text-5xl"
                    style={{ animationDelay: "60ms" }}
                >
                    Practice how
                    <br />
                    you&apos;ll actually
                    <br />
                    <span className="relative inline-block">
                        speak
                        {/* The waveform sits under the word it illustrates. */}
                        <span
                            aria-hidden="true"
                            className="absolute -bottom-1 left-0 flex h-8 w-full items-end gap-[3px] opacity-90 sm:h-10"
                        >
                            {bars.map((b, i) => (
                                <span
                                    key={i}
                                    className="wave-bar block flex-1 rounded-full bg-[image:var(--gradient-primary)]"
                                    style={{
                                        height: `${b.h * 100}%`,
                                        animationDuration: `${b.dur}s`,
                                        animationDelay: `${b.delay}s`,
                                        // @ts-expect-error -- custom properties
                                        "--wave-min": b.min,
                                        "--wave-max": b.max,
                                    }}
                                />
                            ))}
                        </span>
                    </span>
                    .
                </h1>

                <p
                    className="q-enter mb-2 max-w-sm text-sm leading-relaxed text-content-secondary"
                    style={{ animationDelay: "140ms" }}
                >
                    Answer real interview questions, on camera or in writing. We measure your pace,
                    your pauses, and how you came across — and tell you exactly what to change next
                    take.
                </p>
            </div>
        </header>
    );
}

function SessionRow({ mock, delay = 0 }: { mock: MockInterview; delay?: number }) {
    const done = mock.status === "COMPLETED";
    return (
        <Link
            href={`/practice/session/${mock.id}`}
            style={{ animationDelay: `${delay * 40}ms` }}
            className="q-enter flex items-center gap-4 rounded-2xl border border-border-default bg-surface-card p-5 no-underline shadow-md transition-all hover:border-primary-400/40"
        >
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-bold text-content-primary">{mock.job.title}</p>
                    {!done && <Badge tone="accent">In progress</Badge>}
                    {mock.mode !== "TEXT" && <Badge>{mock.mode.toLowerCase()}</Badge>}
                </div>
                <p className="mt-1 text-xs tabular-nums text-content-tertiary">
                    {mock._count.answers} answer{mock._count.answers === 1 ? "" : "s"} ·{" "}
                    {new Date(mock.startedAt).toLocaleDateString()}
                </p>
            </div>
            {mock.overallScore !== null && <ScoreRing value={mock.overallScore} />}
        </Link>
    );
}

/** A small circular progress ring — quieter and more legible at a glance than
 *  a bare number sitting in a list of them. */
function ScoreRing({ value }: { value: number }) {
    const r = 20;
    const c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, value));
    return (
        <div className="relative grid h-14 w-14 shrink-0 place-items-center">
            <svg viewBox="0 0 48 48" className="h-14 w-14 -rotate-90">
                <circle cx="24" cy="24" r={r} fill="none" strokeWidth="4" className="stroke-border-default" />
                <circle
                    cx="24" cy="24" r={r} fill="none" strokeWidth="4" strokeLinecap="round"
                    stroke="url(#scoreGradient)"
                    strokeDasharray={c}
                    strokeDashoffset={c - (pct / 100) * c}
                    className="bar-enter"
                />
                <defs>
                    <linearGradient id="scoreGradient" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="var(--primary-500)" />
                        <stop offset="100%" stopColor="var(--accent-500)" />
                    </linearGradient>
                </defs>
            </svg>
            <span className="absolute text-sm font-black tabular-nums text-content-primary">
                {Math.round(value)}
            </span>
        </div>
    );
}

/**
 * Score across sessions. Deliberately sparse — a sparkline and the change since
 * last time, with no benchmark line, because there is nobody to benchmark
 * against here by design.
 */
function ProgressTrend({ sessions }: { sessions: MockInterview[] }) {
    const scores = sessions.map((s) => s.overallScore as number);
    const latest = scores[scores.length - 1];
    const delta = Math.round(latest - scores[scores.length - 2]);

    const dims = scoreDelta(
        (sessions[sessions.length - 1].dimensionScores || {}) as Record<string, number>,
        (sessions[sessions.length - 2].dimensionScores || {}) as Record<string, number>
    );

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = Math.max(1, max - min);
    const points = scores
        .map((s, i) => `${(i / (scores.length - 1)) * 100},${34 - ((s - min) / span) * 30}`)
        .join(" ");

    return (
        <Card className="score-enter">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-5">
                <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        Your last {scores.length} sessions
                    </p>
                    <div className="mt-1 flex items-baseline gap-2">
                        <span className="text-3xl font-black tabular-nums text-content-primary">
                            {Math.round(latest)}
                        </span>
                        <span
                            className={cx(
                                "text-sm font-bold tabular-nums",
                                delta >= 0 ? "text-emerald-400" : "text-amber-400"
                            )}
                        >
                            {delta >= 0 ? "+" : ""}
                            {delta}
                        </span>
                    </div>
                </div>

                <svg
                    viewBox="0 0 100 36"
                    preserveAspectRatio="none"
                    className="h-10 w-40 overflow-visible"
                    role="img"
                    aria-label={`Session scores: ${scores.map(Math.round).join(", ")}`}
                >
                    <polyline
                        points={points}
                        fill="none"
                        stroke="var(--primary-400)"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                    <circle
                        cx={100}
                        cy={34 - ((latest - min) / span) * 30}
                        r="2.5"
                        fill="var(--primary-400)"
                        vectorEffect="non-scaling-stroke"
                    />
                </svg>

                {Object.keys(dims).length > 0 && (
                    <div className="ml-auto flex flex-wrap gap-5">
                        {Object.entries(dims).map(([dim, d]) => (
                            <div key={dim} className="text-center">
                                <div
                                    className={cx(
                                        "text-sm font-bold tabular-nums",
                                        d >= 0 ? "text-emerald-400" : "text-amber-400"
                                    )}
                                >
                                    {d >= 0 ? "+" : ""}
                                    {d}
                                </div>
                                <div className="text-[10px] capitalize text-content-tertiary">{dim}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Card>
    );
}
