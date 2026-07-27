"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Page,
    PageHeader,
    Card,
    Badge,
    Button,
    ErrorNote,
    Loading,
    Section,
    cx,
} from "@/components/ui";

/**
 * Practice set preview for one role, and the entry point into a session.
 *
 * The questions here come from the JOB POSTING, not from any assessment of this
 * candidate. Ordering is personalized — the competencies their own résumé covers
 * least come first — but the questions are the same for every applicant.
 */

interface PracticeQuestion {
    id: string;
    prompt: string;
    category: string;
    competency: string;
    targetSeconds: number;
}

const CATEGORY: Record<string, { label: string; hint: string }> = {
    ROLE_MOTIVATION: { label: "Warmup", hint: "Settles nerves and sets your baseline" },
    PROJECT_WALKTHROUGH: { label: "Project", hint: "Where interviews are usually won" },
    BEHAVIORAL: { label: "Behavioral", hint: "Structure matters more than content here" },
    TECHNICAL_CONCEPT: { label: "Technical", hint: "Explaining it aloud is its own skill" },
    SYSTEM_DESIGN: { label: "System design", hint: "State your assumptions out loud" },
    PERSONAL: { label: "From your résumé", hint: "Written from a project you listed" },
};

const MODES = [
    {
        value: "VIDEO", label: "Record video", hint: "What you said, and how you came across",
        icon: (
            <path d="M15 8.5l4.2-2.5a1 1 0 0 1 1.5.86v10.28a1 1 0 0 1-1.5.86L15 15.5M5 7h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
        ),
    },
    {
        value: "AUDIO", label: "Record audio", hint: "What you said, and how you sounded",
        icon: (
            <>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
            </>
        ),
    },
    {
        value: "TEXT", label: "Type", hint: "What you said",
        icon: <path d="M5 5h14M5 12h14M5 19h9" />,
    },
] as const;

/** Colour-coded per category so the queue reads at a glance, same vocabulary
 *  as the practice session's progress rail. */
const CATEGORY_DOT: Record<string, string> = {
    ROLE_MOTIVATION: "bg-primary-400",
    PROJECT_WALKTHROUGH: "bg-accent-400",
    BEHAVIORAL: "bg-emerald-400",
    TECHNICAL_CONCEPT: "bg-amber-400",
    SYSTEM_DESIGN: "bg-rose-400",
    PERSONAL: "bg-primary-400",
};

export default function PracticeJobPage({ params }: { params: Promise<{ jobId: string }> }) {
    const { jobId } = use(params);
    const router = useRouter();

    const [job, setJob] = useState<{ title: string } | null>(null);
    const [questions, setQuestions] = useState<PracticeQuestion[]>([]);
    const [loading, setLoading] = useState(true);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [accessibilityMode, setAccessibilityMode] = useState(false);
    const [mode, setMode] = useState<"VIDEO" | "AUDIO" | "TEXT">("VIDEO");
    const [mediaReady, setMediaReady] = useState(true);
    const [consented, setConsented] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const [setRes, capRes] = await Promise.all([
                    fetch(`/api/jobs/${jobId}/practice-set`),
                    fetch(`/api/mock/capabilities`),
                ]);
                if (!setRes.ok) throw new Error(await setRes.text());
                const data = await setRes.json();
                setJob(data.job);
                setQuestions(data.set.questions || []);

                // Fall back to typing when the server can't transcribe. Better to
                // say so now than to let someone record three minutes into a
                // pipeline that can only hand back a content score.
                if (capRes.ok) {
                    const caps = await capRes.json();
                    if (!caps.media_analysis_ready) {
                        setMediaReady(false);
                        setMode("TEXT");
                    }
                }
            } catch (e: any) {
                setError(e.message || "Couldn't load the practice questions");
            } finally {
                setLoading(false);
            }
        })();
    }, [jobId]);

    async function start() {
        setStarting(true);
        setError(null);
        try {
            const res = await fetch("/api/mock", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId, mode, accessibilityMode }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            router.push(`/practice/session/${data.mockInterview.id}`);
        } catch (e: any) {
            setError(e.message || "Couldn't start the session");
            setStarting(false);
        }
    }

    if (loading) {
        return (
            <Page width="narrow">
                <Loading label="Writing your questions…" />
            </Page>
        );
    }

    const totalMinutes = Math.round(questions.reduce((s, q) => s + q.targetSeconds, 0) / 60);

    return (
        <Page width="narrow">
            <PageHeader
                backHref="/practice"
                backLabel="Practice"
                title={job?.title ?? "Practice"}
                description={
                    <>
                        {questions.length} questions to start, about {totalMinutes} minutes of talking. One
                        appears at a time, ordered so the areas your background covers least come first —
                        that&apos;s where practice pays. Skip any of them, and ask for more on any topic when
                        you reach the end.
                    </>
                }
            />

            <div className="space-y-8">
                {error && <ErrorNote>{error}</ErrorNote>}

                <Section title="What you'll be asked">
                    <ol className="space-y-3">
                        {questions.map((q, i) => {
                            const meta = CATEGORY[q.category] ?? { label: q.category, hint: "" };
                            return (
                                <li
                                    key={q.id}
                                    style={{ animationDelay: `${i * 35}ms` }}
                                    className="q-enter group relative overflow-hidden rounded-2xl border border-border-default bg-surface-card p-5 shadow-md transition-colors hover:border-border-hover"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={cx(
                                            "absolute left-0 top-0 h-full w-0.75 opacity-70",
                                            CATEGORY_DOT[q.category] ?? "bg-content-tertiary"
                                        )}
                                    />
                                    <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-bold tabular-nums text-content-tertiary">
                                            {String(i + 1).padStart(2, "0")}
                                        </span>
                                        <Badge tone={q.category === "PERSONAL" ? "accent" : "neutral"}>
                                            {meta.label}
                                        </Badge>
                                        <span className="ml-auto text-[11px] tabular-nums text-content-tertiary">
                                            ~{q.targetSeconds}s
                                        </span>
                                    </div>
                                    <p className="text-sm leading-relaxed text-content-primary">{q.prompt}</p>
                                    {q.competency && (
                                        <p className="mt-2 text-xs text-content-tertiary">
                                            Tests: {q.competency}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </Section>

                <Card className="space-y-5">
                    <fieldset>
                        <legend className="mb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                            How do you want to answer?
                        </legend>
                        <div className="grid gap-2 sm:grid-cols-3">
                            {MODES.map(({ value, label, hint, icon }) => {
                                const locked = !mediaReady && value !== "TEXT";
                                const active = mode === value;
                                return (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => !locked && setMode(value)}
                                        disabled={locked}
                                        aria-pressed={active}
                                        className={cx(
                                            "rounded-2xl border p-3.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
                                            active
                                                ? "border-primary-400/50 bg-primary-500/10 shadow-glow"
                                                : "border-border-default bg-surface-secondary hover:border-border-hover",
                                            locked ? "cursor-not-allowed opacity-40" : "cursor-pointer"
                                        )}
                                    >
                                        <svg
                                            viewBox="0 0 24 24" fill="none" strokeWidth="1.75"
                                            strokeLinecap="round" strokeLinejoin="round"
                                            className={cx(
                                                "mb-2 h-5 w-5 transition-colors",
                                                active ? "text-primary-300" : "text-content-tertiary"
                                            )}
                                        >
                                            {icon}
                                        </svg>
                                        <span className="block text-sm font-bold text-content-primary">
                                            {label}
                                        </span>
                                        <span className="mt-0.5 block text-[11px] leading-snug text-content-tertiary">
                                            {hint}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        {!mediaReady && (
                            <p className="mt-2 text-[11px] text-content-tertiary">
                                Recording is unavailable on this server right now, so typing is the option today.
                            </p>
                        )}
                    </fieldset>

                    {/* Consent before anything is captured, naming what is recorded,
                        what is computed, where it goes, and how long it lives. Only
                        shown for recording modes — typing captures none of it. */}
                    {mode !== "TEXT" && (
                        <div className="rounded-2xl border border-border-default bg-surface-secondary/60 p-4">
                            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                                Before you record
                            </h3>
                            <ul className="space-y-1.5 text-xs leading-relaxed text-content-secondary">
                                <li>
                                    Your {mode === "VIDEO" ? "camera and mic" : "mic"} record only while you press
                                    record. Retake or delete any answer.
                                </li>
                                <li>
                                    Audio goes to this app&apos;s server to be transcribed and measured — pace,
                                    pauses, volume.
                                </li>
                                {mode === "VIDEO" && (
                                    <li>
                                        <strong className="text-content-primary">
                                            Video frames never leave your device.
                                        </strong>{" "}
                                        Framing and eye contact are measured in your browser; only the numbers
                                        are sent.
                                    </li>
                                )}
                                <li>
                                    Nothing reaches a recruiter unless you share it, and sharing sends your
                                    answers and content scores only.
                                </li>
                                <li>Recordings are deleted after 30 days unless you keep them.</li>
                            </ul>
                            <label className="mt-3 flex cursor-pointer items-start gap-3">
                                <input
                                    type="checkbox"
                                    checked={consented}
                                    onChange={(e) => setConsented(e.target.checked)}
                                    className="mt-0.5 cursor-pointer accent-brand-500"
                                />
                                <span className="text-sm text-content-secondary">
                                    I understand, and I&apos;m ready to record.
                                </span>
                            </label>
                        </div>
                    )}

                    {/* No justification asked for, none stored. These metrics track
                        with speech disabilities, accent, and equipment quality, so
                        opting out has to cost nothing. */}
                    <label className="flex cursor-pointer items-start gap-3 border-t border-border-default pt-5">
                        <input
                            type="checkbox"
                            checked={accessibilityMode}
                            onChange={(e) => setAccessibilityMode(e.target.checked)}
                            className="mt-0.5 cursor-pointer accent-brand-500"
                        />
                        <span className="text-sm text-content-secondary">
                            <strong className="text-content-primary">Score content only.</strong> Leaves out any
                            scoring of how you speak or present. What you say is scored in full either way.
                        </span>
                    </label>

                    <Button
                        onClick={start}
                        disabled={starting || questions.length === 0 || (mode !== "TEXT" && !consented)}
                        className="w-full"
                    >
                        {starting ? "Starting…" : "Start practising"}
                    </Button>
                    <p className="text-center text-xs text-content-tertiary">
                        Private to you. Retake any question as often as you like.
                    </p>
                </Card>
            </div>
        </Page>
    );
}
