"use client";

import { useEffect, useState } from "react";
import { verdict } from "@/lib/verdict";

/**
 * The Interview Kit tab: a runnable interview built from a completed session's
 * claim verdicts, plus live note capture during the interview itself.
 *
 * The note capture is not a nicety. Each rating written here produces a
 * (claim, automated verdict, human outcome) triple — the only data that can
 * ever tell us whether the verification pipeline's rulings are right.
 */

type KitQuestion = {
    id: string;
    order: number;
    question: string;
    kind: string;
    targetsClaimId: string | null;
    claimStatus: string | null;
    why: string;
    followUps: string[];
    rubric: {
        strong?: string[];
        weak?: string[];
        disqualifying?: string[];
        note?: string;
    } | null;
    difficulty: string;
    timeBoxMinutes: number | null;
    askedAt: string | null;
    interviewerRating: number | null;
    interviewerNotes: string | null;
};

type Kit = {
    id: string;
    instructions: string | null;
    agenda: { section: string; minutes: number; question_indexes: number[] }[] | null;
    referenceChecks: string[] | null;
    errorMessage: string | null;
    questions: KitQuestion[];
};

/**
 * Question kinds. These describe WHY a question is being asked, which is
 * different from the claim's ruling — a CONTRADICTION probe and a CONTRADICTED
 * claim are related but not the same thing, so the kind badge stays quiet and
 * the ruling badge (from lib/verdict) carries the colour.
 */
const KIND_LABEL: Record<string, string> = {
    CONTRADICTION: "Resolve a contradiction",
    CLAIM_PROBE: "Probe a claim",
    JD_GAP: "Cover a gap",
    DEPTH: "Go deeper",
    BEHAVIORAL: "Behavioral",
};

const DIFFICULTY_LABEL: Record<string, string> = {
    WARMUP: "Warmup",
    CORE: "Core",
    STRETCH: "Stretch",
};

type SharedPractice = {
    scores: { content: number | null; language: number | null };
    answers: { question: string; contentScore: number | null; answerText: string | null }[];
};

/**
 * A practice session the candidate chose to attach to this application.
 *
 * Content only, by construction — the server builds this through an allowlist,
 * so delivery and presentation scores are not filtered out here, they were
 * never selected. The note says so plainly, because a recruiter must not read
 * their absence as the candidate having done badly on them.
 */
function SharedPractice({ sessionId }: { sessionId: string }) {
    const [data, setData] = useState<{ shared: SharedPractice | null; note?: string } | null>(null);

    useEffect(() => {
        fetch(`/api/vet/session/${sessionId}/shared-practice`)
            .then((r) => (r.ok ? r.json() : { shared: null }))
            .then(setData)
            .catch(() => setData({ shared: null }));
    }, [sessionId]);

    if (!data?.shared) return null;

    return (
        <div className="bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
            <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest mb-1">
                Practice shared by the candidate
            </h3>
            <p className="text-xs text-content-tertiary mb-4">{data.note}</p>
            <div className="flex gap-5 mb-4">
                {(["content", "language"] as const).map((dim) => (
                    <div key={dim}>
                        <div className="text-lg font-bold text-content-primary tabular-nums">
                            {data.shared!.scores[dim] ?? "—"}
                        </div>
                        <div className="text-[10px] capitalize text-content-tertiary">{dim}</div>
                    </div>
                ))}
            </div>
            <div className="space-y-3">
                {data.shared.answers.map((a, i) => (
                    <details key={i} className="rounded-xl border border-border-default bg-surface-secondary p-3">
                        <summary className="cursor-pointer text-xs font-semibold text-content-primary">
                            {a.question}
                            {a.contentScore !== null && (
                                <span className="ml-2 text-content-tertiary tabular-nums">{a.contentScore}</span>
                            )}
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-content-secondary">
                            {a.answerText || "—"}
                        </p>
                    </details>
                ))}
            </div>
        </div>
    );
}

export default function InterviewKit({ sessionId }: { sessionId: string }) {
    const [kit, setKit] = useState<Kit | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [instructions, setInstructions] = useState("");
    const [duration, setDuration] = useState(45);
    const [expanded, setExpanded] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/vet/session/${sessionId}/kit`);
                if (!res.ok) throw new Error(await res.text());
                const data = await res.json();
                if (!cancelled) setKit(data.kit);
            } catch (e: any) {
                if (!cancelled) setError(e.message || "Failed to load the interview kit");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    async function generate() {
        // Regenerating replaces the kit wholesale, which discards notes taken
        // against the old questions. Warn only when there is something to lose.
        const hasNotes = kit?.questions.some((q) => q.interviewerRating || q.interviewerNotes || q.askedAt);
        if (hasNotes && !confirm("Regenerating replaces this kit and discards the notes you've already taken on it. Continue?")) {
            return;
        }

        setGenerating(true);
        setError(null);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/kit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ instructions, durationMinutes: duration }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            setKit(data.kit);
        } catch (e: any) {
            setError(e.message || "Failed to generate the interview kit");
        } finally {
            setGenerating(false);
        }
    }

    async function patchQuestion(questionId: string, body: Record<string, unknown>) {
        // Optimistic: an interviewer is typing during a live conversation and
        // must never wait on a round trip to see their own keystroke.
        setKit((prev) =>
            prev
                ? { ...prev, questions: prev.questions.map((q) => (q.id === questionId ? { ...q, ...camelize(body) } : q)) }
                : prev
        );
        try {
            await fetch(`/api/kit/question/${questionId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch {
            // Deliberately silent. A failed note save must not throw an error
            // dialog over a live interview; the next keystroke retries.
        }
    }

    if (loading) {
        return <div className="bg-surface-card border border-border-default rounded-3xl p-8 text-center text-sm text-content-tertiary shadow-md">Loading interview kit…</div>;
    }

    const totalMinutes = kit?.questions.reduce((sum, q) => sum + (q.timeBoxMinutes || 0), 0) ?? 0;
    const askedCount = kit?.questions.filter((q) => q.askedAt).length ?? 0;

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <SharedPractice sessionId={sessionId} />

            {/* Generator controls */}
            <div className="bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex-1 min-w-60">
                        <label className="block text-xs font-bold text-content-tertiary uppercase tracking-widest mb-2">
                            Steer the kit (optional)
                        </label>
                        <input
                            value={instructions}
                            onChange={(e) => setInstructions(e.target.value)}
                            placeholder="e.g. focus on system design; this is a 30-minute screen"
                            className="w-full px-4 py-2.5 rounded-xl bg-surface-secondary border border-border-default text-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-content-tertiary uppercase tracking-widest mb-2">
                            Slot
                        </label>
                        <select
                            value={duration}
                            onChange={(e) => setDuration(Number(e.target.value))}
                            className="px-4 py-2.5 rounded-xl bg-surface-secondary border border-border-default text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-brand-500/40 cursor-pointer"
                        >
                            <option value={30}>30 min</option>
                            <option value={45}>45 min</option>
                            <option value={60}>60 min</option>
                        </select>
                    </div>
                    <button
                        onClick={generate}
                        disabled={generating}
                        className="px-6 py-2.5 rounded-xl bg-brand-500 text-white text-sm font-bold shadow-sm hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
                    >
                        {generating ? "Building…" : kit ? "Regenerate" : "Build Interview Kit"}
                    </button>
                </div>

                {kit && (
                    <div className="mt-4 pt-4 border-t border-border-default flex flex-wrap gap-x-6 gap-y-2 text-xs text-content-tertiary">
                        <span><strong className="text-content-secondary">{kit.questions.length}</strong> questions</span>
                        <span><strong className="text-content-secondary">{totalMinutes}</strong> min of probes</span>
                        <span><strong className="text-content-secondary">{askedCount}</strong> asked</span>
                        {kit.instructions && <span>Steered: “{kit.instructions}”</span>}
                    </div>
                )}
            </div>

            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 text-sm text-rose-400">{error}</div>
            )}

            {!kit && !error && (
                <div className="bg-surface-card border border-border-default rounded-3xl p-10 text-center shadow-md">
                    <p className="text-sm text-content-secondary max-w-lg mx-auto">
                        Build a runnable interview from this session&apos;s claim verdicts — questions bound to the
                        claims that couldn&apos;t be settled from public sources, each with follow-up rungs and a
                        rubric. Claims already verified are deliberately not re-asked.
                    </p>
                </div>
            )}

            {kit?.errorMessage && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 text-sm text-amber-300">
                    {kit.errorMessage}
                </div>
            )}

            {/* Agenda */}
            {kit?.agenda && kit.agenda.length > 0 && (
                <div className="bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                    <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest mb-4">Running order</h3>
                    <div className="flex flex-wrap gap-2">
                        {kit.agenda.map((section, i) => (
                            <div key={i} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border-default">
                                <span className="text-sm font-semibold text-content-primary">{section.section}</span>
                                <span className="ml-2 text-xs text-content-tertiary">{section.minutes} min</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Questions */}
            {kit?.questions.map((q) => {
                const v = verdict(q.claimStatus);
                const isOpen = expanded === q.id;
                return (
                    <div
                        key={q.id}
                        className={`bg-surface-card border rounded-3xl shadow-md transition-all ${
                            q.askedAt ? "border-primary-400/40" : "border-border-default"
                        }`}
                    >
                        <div className="p-6">
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                {/* The ruling carries the colour — one vocabulary,
                                    used identically on every screen. */}
                                {q.claimStatus && (
                                    <span
                                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-[0.12em] border ${v.pill}`}
                                        title={v.blurb}
                                    >
                                        {q.targetsClaimId ? `${q.targetsClaimId} · ` : ""}
                                        {q.claimStatus}
                                    </span>
                                )}
                                <span className="px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-[0.12em] bg-surface-secondary text-content-tertiary border border-border-default">
                                    {KIND_LABEL[q.kind] || q.kind}
                                </span>
                                <span className="px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-[0.12em] bg-surface-secondary text-content-tertiary border border-border-default">
                                    {DIFFICULTY_LABEL[q.difficulty] || q.difficulty}
                                </span>
                                {q.timeBoxMinutes && (
                                    <span className="text-[10px] font-semibold tabular-nums text-content-tertiary">
                                        {q.timeBoxMinutes} min
                                    </span>
                                )}
                                <button
                                    onClick={() => patchQuestion(q.id, { asked: !q.askedAt })}
                                    className={`ml-auto px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                                        q.askedAt
                                            ? "bg-brand-500 text-white"
                                            : "bg-surface-secondary text-content-secondary hover:bg-surface-tertiary border border-border-default"
                                    }`}
                                >
                                    {q.askedAt ? "✓ Asked" : "Mark asked"}
                                </button>
                            </div>

                            <p className="text-base font-semibold text-content-primary leading-relaxed">{q.question}</p>
                            {q.why && <p className="mt-2 text-xs text-content-tertiary italic">{q.why}</p>}

                            {q.followUps.length > 0 && (
                                <ol className="mt-4 space-y-2 border-l-2 border-border-default pl-4">
                                    {q.followUps.map((f, i) => (
                                        <li key={i} className="text-sm text-content-secondary">
                                            <span className="text-[10px] font-bold text-content-tertiary mr-2">L{i + 2}</span>
                                            {f}
                                        </li>
                                    ))}
                                </ol>
                            )}

                            <button
                                onClick={() => setExpanded(isOpen ? null : q.id)}
                                className="mt-4 text-xs font-bold text-primary-300 hover:text-primary-200 cursor-pointer"
                            >
                                {isOpen ? "Hide rubric & notes" : "Rubric & notes"}
                            </button>
                        </div>

                        {isOpen && (
                            <div className="px-6 pb-6 space-y-5 border-t border-border-default pt-5">
                                {q.rubric && (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <RubricColumn title="Strong answer" items={q.rubric.strong} tone="text-emerald-400" />
                                        <RubricColumn title="Thin answer" items={q.rubric.weak} tone="text-amber-400" />
                                        <RubricColumn title="Disqualifying" items={q.rubric.disqualifying} tone="text-rose-400" />
                                    </div>
                                )}
                                {q.rubric?.note && (
                                    <p className="text-xs text-content-tertiary bg-surface-secondary rounded-xl p-3 border border-border-default">
                                        <strong className="text-content-secondary">Watch out:</strong> {q.rubric.note}
                                    </p>
                                )}

                                <div>
                                    <label className="block text-xs font-bold text-content-tertiary uppercase tracking-widest mb-2">
                                        How did they answer?
                                    </label>
                                    <div className="flex gap-2 mb-3">
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <button
                                                key={n}
                                                onClick={() => patchQuestion(q.id, { interviewerRating: q.interviewerRating === n ? null : n })}
                                                className={`w-10 h-10 rounded-xl text-sm font-bold transition-all cursor-pointer ${
                                                    q.interviewerRating === n
                                                        ? "bg-brand-500 text-white shadow-sm"
                                                        : "bg-surface-secondary text-content-secondary border border-border-default hover:bg-surface-tertiary"
                                                }`}
                                            >
                                                {n}
                                            </button>
                                        ))}
                                    </div>
                                    <textarea
                                        value={q.interviewerNotes ?? ""}
                                        onChange={(e) => patchQuestion(q.id, { interviewerNotes: e.target.value })}
                                        placeholder="What they actually said…"
                                        rows={3}
                                        className="w-full px-4 py-3 rounded-xl bg-surface-secondary border border-border-default text-sm text-content-primary placeholder:text-content-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 resize-y"
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Reference checks — for a former manager, never for the candidate */}
            {kit?.referenceChecks && kit.referenceChecks.length > 0 && (
                <div className="bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                    <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest mb-1">Reference check</h3>
                    <p className="text-xs text-content-tertiary mb-4">
                        For a former manager on a reference call — not for the candidate.
                    </p>
                    <ul className="space-y-2">
                        {kit.referenceChecks.map((r, i) => (
                            <li key={i} className="text-sm text-content-secondary flex gap-2">
                                <span className="text-content-tertiary">·</span>
                                {r}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function RubricColumn({ title, items, tone }: { title: string; items?: string[]; tone: string }) {
    if (!items || items.length === 0) return null;
    return (
        <div>
            <h4 className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${tone}`}>{title}</h4>
            <ul className="space-y-1.5">
                {items.map((item, i) => (
                    <li key={i} className="text-xs text-content-secondary leading-relaxed">
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Map the API's snake_case-ish patch body onto the client model's field names. */
function camelize(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...body };
    if ("asked" in body) {
        out.askedAt = body.asked ? new Date().toISOString() : null;
        delete out.asked;
    }
    return out;
}
