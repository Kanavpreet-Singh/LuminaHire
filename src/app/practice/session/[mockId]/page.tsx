"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Recorder, { type RecordedTake } from "@/components/practice/Recorder";
import AnswerRibbon, { formatClock } from "@/components/practice/AnswerRibbon";
import ShareDialog from "@/components/practice/ShareDialog";
import QueueTopUp from "@/components/practice/QueueTopUp";
import { useUploadThing } from "@/utils/uploadthing";
import { Page, Card, Badge, Button, Textarea, ErrorNote, Loading, Meter, cx } from "@/components/ui";

/**
 * The practice session — ONE question on screen at a time.
 *
 * An interview is a sequence you move through, not a form you fill in. Showing
 * the whole list at once invites skimming ahead and rehearsing, which is exactly
 * the habit that makes people worse in the room. So: one question, answer it,
 * see how it went, move on.
 *
 * Skipping is always available and never penalised — someone who wants to drill
 * system design shouldn't have to answer a warmup to get there. The queue is
 * unbounded: when it runs out you pick a category and get more.
 */

interface Question {
    id: string;
    order: number;
    prompt: string;
    category: string;
    competency: string;
    targetSeconds: number;
    followUpHints: string[];
}

interface Answer {
    id: string;
    questionId: string;
    attemptNo: number;
    isFinal: boolean;
    answerText: string | null;
    mediaUrl: string | null;
    durationSeconds: number | null;
    score: number | null;
    status: string;
    errorMessage: string | null;
    metrics: any;
    faceTimeline: any;
    analysis: any;
}

interface Mock {
    id: string;
    status: string;
    mode: "VIDEO" | "AUDIO" | "TEXT";
    accessibilityMode: boolean;
    overallScore: number | null;
    dimensionScores: Record<string, number> | null;
    coaching: any;
    job: { id: string; title: string };
    practiceSet: { questions: Question[] };
    answers: Answer[];
}

const CATEGORY_LABEL: Record<string, string> = {
    ROLE_MOTIVATION: "Warmup",
    PROJECT_WALKTHROUGH: "Project",
    BEHAVIORAL: "Behavioural",
    TECHNICAL_CONCEPT: "Technical",
    SYSTEM_DESIGN: "System design",
    PERSONAL: "From your résumé",
};

export default function PracticeSessionPage({ params }: { params: Promise<{ mockId: string }> }) {
    const { mockId } = use(params);
    const router = useRouter();

    const [mock, setMock] = useState<Mock | null>(null);
    const [history, setHistory] = useState<{ overallScore: number | null }[]>([]);
    const [applications, setApplications] = useState<{ id: string; jobTitle: string; companyName: string }[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cursor, setCursor] = useState(0);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [uploadPct, setUploadPct] = useState(0);
    const [sharing, setSharing] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [reviewing, setReviewing] = useState(false);

    const { startUpload } = useUploadThing("mockVideoUploader", { onUploadProgress: setUploadPct });

    const load = useCallback(async () => {
        const res = await fetch(`/api/mock/${mockId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setMock(data.mockInterview);
        setHistory(data.history || []);
        setApplications(data.applications || []);
        return data.mockInterview as Mock;
    }, [mockId]);

    useEffect(() => {
        load()
            .catch((e) => setError(e.message || "Couldn't load this session"))
            .finally(() => setLoading(false));
    }, [load]);

    const analyzing = mock?.answers.some((a) => a.status === "ANALYZING") ?? false;
    useEffect(() => {
        if (!analyzing) return;
        const id = setInterval(() => void load().catch(() => {}), 4000);
        return () => clearInterval(id);
    }, [analyzing, load]);

    const questions = useMemo(() => mock?.practiceSet.questions ?? [], [mock]);
    const finalByQuestion = useMemo(
        () => new Map((mock?.answers ?? []).filter((a) => a.isFinal).map((a) => [a.questionId, a])),
        [mock]
    );

    // Land on the first unanswered question rather than always question one, so
    // returning to a session picks up where it left off.
    const settledRef = useRef(false);
    useEffect(() => {
        if (settledRef.current || questions.length === 0) return;
        settledRef.current = true;
        const next = questions.findIndex((q) => !finalByQuestion.has(q.id));
        setCursor(next === -1 ? questions.length : next);
    }, [questions, finalByQuestion]);

    if (loading) {
        return (
            <Page width="narrow">
                <Loading label="Loading your session…" />
            </Page>
        );
    }
    if (error && !mock) {
        return (
            <Page width="narrow">
                <ErrorNote>{error}</ErrorNote>
            </Page>
        );
    }
    if (!mock) return null;

    const answeredCount = finalByQuestion.size;
    const isComplete = mock.status === "COMPLETED";
    const atEnd = cursor >= questions.length;
    const question = atEnd ? null : questions[cursor];
    const existing = question ? finalByQuestion.get(question.id) : undefined;

    /** Advance with a short exit animation, so the queue feels like it moves. */
    function goTo(index: number) {
        setLeaving(true);
        setTimeout(() => {
            setCursor(Math.max(0, Math.min(questions.length, index)));
            setDraft("");
            setLeaving(false);
        }, 180);
    }

    async function submitText() {
        if (!question || !draft.trim()) return;
        setBusy("Scoring your answer…");
        setError(null);
        try {
            const res = await fetch(`/api/mock/${mockId}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ questionId: question.id, answerText: draft }),
            });
            if (!res.ok) throw new Error(await res.text());
            setDraft("");
            await load();
        } catch (e: any) {
            setError(e.message || "Couldn't submit that answer");
        } finally {
            setBusy(null);
        }
    }

    async function submitTake(take: RecordedTake) {
        if (!question) return;
        setError(null);
        setUploadPct(0);
        setBusy("Uploading your recording…");
        try {
            // Upload first, always. The take is durable before anything can fail,
            // so a scoring problem never costs a recording.
            const ext = take.mimeType.includes("mp4") ? "mp4" : "webm";
            const file = new File([take.blob], `answer-${question.id}.${ext}`, { type: take.mimeType });
            const uploaded = await startUpload([file]);
            const url = uploaded?.[0]?.url;
            if (!url) throw new Error("Upload didn't finish. Your take is still here — try again.");

            setBusy("Analyzing…");
            const res = await fetch(`/api/mock/${mockId}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    questionId: question.id,
                    mediaUrl: url,
                    mediaKey: (uploaded?.[0] as any)?.key ?? null,
                    mimeType: take.mimeType,
                    durationSeconds: take.durationSeconds,
                    faceTrack: take.faceTrack,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            await load();
        } catch (e: any) {
            setError(e.message || "Couldn't submit that recording");
        } finally {
            setBusy(null);
            setUploadPct(0);
        }
    }

    async function finalize() {
        setBusy("Reviewing your session…");
        setError(null);
        try {
            const res = await fetch(`/api/mock/${mockId}/finalize`, { method: "POST" });
            if (!res.ok) throw new Error(await res.text());
            await load();
            setReviewing(true);
        } catch (e: any) {
            setError(e.message || "Couldn't finish the session");
        } finally {
            setBusy(null);
        }
    }

    async function deleteSession() {
        if (!confirm("Delete this session and its recordings? This can't be undone.")) return;
        const res = await fetch(`/api/mock/${mockId}`, { method: "DELETE" });
        if (res.ok) router.push("/practice");
        else setError(await res.text());
    }

    return (
        <Page width="narrow">
            {sharing && (
                <ShareDialog
                    mockId={mock.id}
                    applications={applications}
                    onClose={() => {
                        setSharing(false);
                        void load().catch(() => {});
                    }}
                />
            )}

            <ProgressRail
                jobTitle={mock.job.title}
                questions={questions}
                cursor={cursor}
                answeredIds={finalByQuestion}
                onJump={goTo}
                mode={mock.mode}
                accessibilityMode={mock.accessibilityMode}
                onExit={() => router.push("/practice")}
                onDelete={deleteSession}
            />

            <div className="mt-8 space-y-6">
                {error && <ErrorNote>{error}</ErrorNote>}

                {(isComplete || reviewing) && (
                    <SessionResults
                        mock={mock}
                        history={history}
                        onShare={() => setSharing(true)}
                        onKeepGoing={() => {
                            setReviewing(false);
                            goTo(questions.length);
                        }}
                    />
                )}

                {atEnd && !isComplete && (
                    <QueueTopUp
                        mockId={mock.id}
                        answered={answeredCount}
                        onAdded={async () => {
                            const updated = await load();
                            // Jump straight to the first of the new questions.
                            const next = updated.practiceSet.questions.findIndex(
                                (q) => !updated.answers.some((a) => a.isFinal && a.questionId === q.id)
                            );
                            setCursor(next === -1 ? updated.practiceSet.questions.length : next);
                        }}
                    />
                )}

                {question && (
                    <div key={question.id} className={cx(leaving ? "q-leaving" : "q-enter")}>
                        <Card className="q-stagger space-y-6">
                            <div>
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] font-bold tabular-nums text-content-tertiary">
                                        {String(cursor + 1).padStart(2, "0")}
                                    </span>
                                    <Badge tone={question.category === "PERSONAL" ? "accent" : "neutral"}>
                                        {CATEGORY_LABEL[question.category] || question.category}
                                    </Badge>
                                    {existing && <Badge tone="success">Answered</Badge>}
                                    <span className="ml-auto text-[11px] tabular-nums text-content-tertiary">
                                        aim for {formatClock(question.targetSeconds)}
                                    </span>
                                </div>
                                <h1 className="text-[1.6rem] font-semibold leading-snug tracking-tight text-content-primary">
                                    {question.prompt}
                                </h1>
                                {question.competency && (
                                    <p className="mt-2 text-xs text-content-tertiary">
                                        Tests: {question.competency}
                                    </p>
                                )}
                            </div>

                            {existing && <AnswerResult answer={existing} question={question} />}

                            {busy ? (
                                <div className="rounded-2xl border border-border-default bg-surface-secondary/60 p-6 text-center">
                                    <p className="text-sm text-content-secondary">{busy}</p>
                                    {uploadPct > 0 && uploadPct < 100 && (
                                        <div className="mx-auto mt-3 w-48">
                                            <Meter value={uploadPct} />
                                        </div>
                                    )}
                                </div>
                            ) : mock.mode === "TEXT" ? (
                                <div>
                                    <label
                                        htmlFor="answer"
                                        className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary"
                                    >
                                        {existing ? "Answer it again" : "Your answer"}
                                    </label>
                                    <Textarea
                                        id="answer"
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        rows={7}
                                        placeholder="Answer as if you were saying it out loud."
                                    />
                                    <div className="mt-3 flex flex-wrap items-center gap-3">
                                        <Button onClick={submitText} disabled={!draft.trim()}>
                                            {existing ? "Score this take" : "Submit answer"}
                                        </Button>
                                        <NextControl
                                            cursor={cursor}
                                            total={questions.length}
                                            answered={!!existing}
                                            onNext={() => goTo(cursor + 1)}
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <Recorder
                                        key={question.id}
                                        mode={mock.mode === "AUDIO" ? "AUDIO" : "VIDEO"}
                                        targetSeconds={question.targetSeconds}
                                        onComplete={submitTake}
                                    />
                                    <NextControl
                                        cursor={cursor}
                                        total={questions.length}
                                        answered={!!existing}
                                        onNext={() => goTo(cursor + 1)}
                                    />
                                </div>
                            )}
                        </Card>
                    </div>
                )}

                {answeredCount > 0 && !isComplete && !reviewing && (
                    <Button tone="secondary" onClick={finalize} disabled={!!busy} className="w-full">
                        Finish and review {answeredCount} answer{answeredCount === 1 ? "" : "s"}
                    </Button>
                )}
            </div>
        </Page>
    );
}

/**
 * Where you are in the queue. Dots rather than a numbered grid: with an
 * unbounded queue the count is not a target, so a progress bar would keep
 * lying about how far along you are.
 */
function ProgressRail({
    jobTitle, questions, cursor, answeredIds, onJump, mode, accessibilityMode, onExit, onDelete,
}: {
    jobTitle: string;
    questions: Question[];
    cursor: number;
    answeredIds: Map<string, Answer>;
    onJump: (i: number) => void;
    mode: string;
    accessibilityMode: boolean;
    onExit: () => void;
    onDelete: () => void;
}) {
    return (
        <header className="space-y-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <button
                    onClick={onExit}
                    className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.14em] text-content-tertiary transition-colors hover:text-content-primary"
                >
                    ← Practice
                </button>
                <h2 className="text-sm font-bold text-content-primary">{jobTitle}</h2>
                <span className="text-[11px] tabular-nums text-content-tertiary">
                    {answeredIds.size} answered
                    {mode !== "TEXT" && ` · ${mode.toLowerCase()}`}
                    {accessibilityMode && " · content only"}
                </span>
                <button
                    onClick={onDelete}
                    className="ml-auto cursor-pointer text-[11px] font-bold text-content-tertiary transition-colors hover:text-rose-400"
                >
                    Delete
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Questions">
                {questions.map((q, i) => {
                    const a = answeredIds.get(q.id);
                    const state = !a ? "todo" : a.status === "ANALYZING" ? "working" : a.status === "FAILED" ? "failed" : "done";
                    const current = i === cursor;
                    return (
                        <button
                            key={q.id}
                            role="tab"
                            aria-selected={current}
                            aria-label={`Question ${i + 1}, ${state}`}
                            onClick={() => onJump(i)}
                            className={cx(
                                "h-1.5 rounded-full transition-all duration-300 cursor-pointer",
                                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400",
                                current ? "w-8" : "w-4 hover:w-6",
                                current
                                    ? "bg-[image:var(--gradient-primary)]"
                                    : state === "done"
                                      ? "bg-emerald-400/70"
                                      : state === "working"
                                        ? "bg-primary-400/60 rec-dot"
                                        : state === "failed"
                                          ? "bg-amber-400/70"
                                          : "bg-border-hover"
                            )}
                        />
                    );
                })}
                <span
                    className={cx(
                        "ml-1 h-1.5 w-4 rounded-full transition-all",
                        cursor >= questions.length ? "w-8 bg-[image:var(--gradient-primary)]" : "bg-border-default"
                    )}
                    title="More questions"
                    aria-hidden="true"
                />
            </div>
        </header>
    );
}

/** Skipping is always offered and never framed as failure. */
function NextControl({
    cursor, total, answered, onNext,
}: { cursor: number; total: number; answered: boolean; onNext: () => void }) {
    const last = cursor >= total - 1;
    if (answered) {
        return (
            <Button onClick={onNext}>{last ? "Done — what's next" : "Next question →"}</Button>
        );
    }
    return (
        <Button tone="ghost" onClick={onNext}>
            {last ? "Skip — what's next" : "Skip for now"}
        </Button>
    );
}

function AnswerResult({ answer, question }: { answer: Answer; question: Question }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const coaching = answer.analysis?.coaching || {};
    const content = coaching.content_feedback || {};
    const scores = answer.analysis?.scores || {};
    const degraded: string[] = answer.analysis?.degraded || [];
    const summary = coaching.delivery_summary as
        | { paragraph: string; improvements: string[] }
        | undefined;

    if (answer.status === "ANALYZING") {
        return (
            <div className="rounded-2xl border border-primary-400/25 bg-primary-500/5 p-5 text-center">
                <span className="mx-auto mb-2 block h-2 w-2 rounded-full bg-primary-400 rec-dot" />
                <p className="text-sm text-content-secondary">
                    Scoring your answer. A recording takes about a minute — skip ahead and come back.
                </p>
            </div>
        );
    }

    if (answer.status === "FAILED") {
        return (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-400">
                Your answer is saved. Scoring failed — submit again to retry, you won&apos;t lose the take.
                {answer.errorMessage && (
                    <span className="mt-1 block text-xs opacity-70">{answer.errorMessage}</span>
                )}
            </div>
        );
    }

    const seek = (t: number) => {
        if (videoRef.current) {
            videoRef.current.currentTime = t;
            void videoRef.current.play().catch(() => {});
        }
    };

    return (
        <div className="score-enter space-y-5 rounded-2xl border border-border-default bg-surface-secondary/60 p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-black tabular-nums text-content-primary">
                        {answer.score !== null ? Math.round(answer.score) : "—"}
                    </span>
                    <span className="text-xs text-content-tertiary">/100</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-2">
                    {Object.entries(scores).map(([dim, value], i) => (
                        <div key={dim} className="min-w-[4.5rem]">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-[10px] capitalize text-content-tertiary">{dim}</span>
                                <span className="text-xs font-bold tabular-nums text-content-secondary">
                                    {Math.round(value as number)}
                                </span>
                            </div>
                            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-tertiary">
                                <div
                                    className="bar-enter h-full rounded-full bg-[image:var(--gradient-primary)]"
                                    style={{
                                        width: `${Math.max(0, Math.min(100, value as number))}%`,
                                        animationDelay: `${120 + i * 90}ms`,
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
                <span className="text-[10px] tabular-nums text-content-tertiary">take {answer.attemptNo}</span>
            </div>

            {answer.mediaUrl && (
                <video ref={videoRef} src={answer.mediaUrl} controls className="aspect-video w-full rounded-xl bg-black" />
            )}

            <AnswerRibbon
                durationSeconds={answer.durationSeconds || answer.metrics?.answer_duration_s || 0}
                targetSeconds={question.targetSeconds}
                speechTimeline={answer.metrics?.speech_timeline}
                faceTimeline={answer.faceTimeline}
                affectTimeline={answer.metrics?.affect_timeline}
                stallTimestamps={answer.metrics?.stall_timestamps || []}
                onSeek={answer.mediaUrl ? seek : undefined}
            />

            {/* How you spoke, in prose. Every figure in this paragraph is
                templated from a measurement — see python/media/narrate.py. */}
            {summary?.paragraph && (
                <div className="rounded-2xl border border-border-default bg-surface-card p-4">
                    <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        How you came across
                    </h4>
                    <p className="text-sm leading-relaxed text-content-secondary">{summary.paragraph}</p>

                    {summary.improvements?.length > 0 ? (
                        <div className="mt-4 border-t border-border-default pt-3">
                            <h5 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary-300">
                                Where to improve
                            </h5>
                            <ul className="space-y-1.5">
                                {summary.improvements.map((s: string, i: number) => (
                                    <li key={i} className="text-sm leading-relaxed text-content-primary">
                                        {s}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <p className="mt-3 border-t border-border-default pt-3 text-sm text-emerald-400">
                            Nothing to fix in how you delivered this one.
                        </p>
                    )}

                    {answer.metrics?.affect_available === false && (
                        <p className="mt-3 text-[11px] text-content-tertiary">
                            {answer.metrics.affect_reason}
                        </p>
                    )}
                </div>
            )}

            {coaching.strongest_moment && (
                <p className="text-sm text-content-secondary">
                    <span className="font-semibold text-emerald-400">Strongest bit:</span>{" "}
                    “{coaching.strongest_moment}”
                </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
                <FeedbackList title="You covered" items={content.covered} tone="text-emerald-400" />
                <FeedbackList title="You didn't reach" items={content.missed} tone="text-amber-400" />
            </div>

            {content.structure && (
                <p className="text-sm text-content-secondary">
                    <span className="font-semibold text-content-primary">Structure.</span> {content.structure}
                </p>
            )}
            {content.rewrite_hint && (
                <p className="rounded-xl border border-border-default bg-surface-card p-3 text-sm text-content-secondary">
                    <span className="font-semibold text-content-primary">Try adding.</span>{" "}
                    {content.rewrite_hint}
                </p>
            )}

            {(coaching.delivery_feedback?.length > 0 || coaching.presence_feedback?.length > 0) && (
                <div className="space-y-3 border-t border-border-default pt-4">
                    {[...(coaching.delivery_feedback || []), ...(coaching.presence_feedback || [])].map(
                        (item: any, i: number) => (
                            <Observation key={i} item={item} onSeek={answer.mediaUrl ? seek : undefined} />
                        )
                    )}
                </div>
            )}

            {coaching.top_fixes?.length > 0 && (
                <div className="border-t border-border-default pt-4">
                    <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        Next take
                    </h4>
                    <ul className="space-y-1.5">
                        {coaching.top_fixes.map((fix: string, i: number) => (
                            <li key={i} className="text-sm font-medium text-content-primary">{fix}</li>
                        ))}
                    </ul>
                </div>
            )}

            {question.followUpHints.length > 0 && (
                <p className="text-xs text-content-tertiary">
                    A real interviewer would ask next: {question.followUpHints.join(" · ")}
                </p>
            )}

            {degraded.length > 0 && (
                <p className="text-[11px] text-content-tertiary">
                    Not measured this time: {degraded.join(", ")}. Left out of your score rather than counted
                    against it.
                </p>
            )}
        </div>
    );
}

function Observation({ item, onSeek }: { item: any; onSeek?: (t: number) => void }) {
    return (
        <div className="rounded-xl border border-border-default bg-surface-card p-3">
            <p className="text-xs font-bold tabular-nums text-content-primary">{item.observation}</p>
            {item.read && <p className="mt-1 text-xs text-content-secondary">{item.read}</p>}
            {item.drill && <p className="mt-1.5 text-xs font-semibold text-primary-300">Try: {item.drill}</p>}
            {Array.isArray(item.when) && item.when.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-content-tertiary">
                    {item.when.map((t: number) => (
                        <button
                            key={t}
                            onClick={() => onSeek?.(t)}
                            disabled={!onSeek}
                            className="rounded border border-border-default px-1.5 py-0.5 tabular-nums transition-colors enabled:cursor-pointer enabled:hover:text-content-primary disabled:opacity-60"
                        >
                            {formatClock(t)}
                        </button>
                    ))}
                </p>
            )}
        </div>
    );
}

function SessionResults({
    mock, history, onShare, onKeepGoing,
}: {
    mock: Mock;
    history: { overallScore: number | null }[];
    onShare: () => void;
    onKeepGoing: () => void;
}) {
    const coaching = mock.coaching || {};
    const previous = history[0]?.overallScore ?? null;
    const delta =
        mock.overallScore !== null && previous !== null ? Math.round(mock.overallScore - previous) : null;

    return (
        <Card className="score-enter space-y-5">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        This session
                    </p>
                    <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-black tabular-nums text-content-primary">
                            {mock.overallScore !== null ? Math.round(mock.overallScore) : "—"}
                        </span>
                        <span className="text-sm text-content-tertiary">/100</span>
                    </div>
                </div>
                {delta !== null && (
                    <p className={cx("text-sm font-bold tabular-nums", delta >= 0 ? "text-emerald-400" : "text-amber-400")}>
                        {delta >= 0 ? "+" : ""}{delta}{" "}
                        <span className="font-normal text-content-tertiary">vs your last session</span>
                    </p>
                )}
                <div className="ml-auto flex gap-5">
                    {Object.entries(mock.dimensionScores || {}).map(([dim, value]) => (
                        <div key={dim} className="text-center">
                            <div className="text-lg font-bold tabular-nums text-content-primary">
                                {Math.round(value)}
                            </div>
                            <div className="text-[10px] capitalize text-content-tertiary">{dim}</div>
                        </div>
                    ))}
                </div>
            </div>

            {coaching.narrative && (
                <p className="text-sm leading-relaxed text-content-secondary">{coaching.narrative}</p>
            )}

            {coaching.patterns?.length > 0 && (
                <div>
                    <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        Across your answers
                    </h4>
                    <ul className="space-y-1.5">
                        {coaching.patterns.map((p: string, i: number) => (
                            <li key={i} className="text-sm text-content-secondary">{p}</li>
                        ))}
                    </ul>
                </div>
            )}

            {coaching.top_fixes?.length > 0 && (
                <div className="rounded-2xl border border-border-default bg-surface-secondary/60 p-4">
                    <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                        Work on these
                    </h4>
                    <ul className="space-y-1.5">
                        {coaching.top_fixes.map((fix: string, i: number) => (
                            <li key={i} className="text-sm font-medium text-content-primary">{fix}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="flex flex-wrap gap-3 border-t border-border-default pt-5">
                <Button onClick={onShare}>Share with a recruiter</Button>
                <Button tone="secondary" onClick={onKeepGoing}>Keep practising</Button>
            </div>
        </Card>
    );
}

function FeedbackList({ title, items, tone }: { title: string; items?: string[]; tone: string }) {
    if (!items || items.length === 0) return null;
    return (
        <div>
            <h4 className={cx("mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em]", tone)}>{title}</h4>
            <ul className="space-y-1">
                {items.map((item, i) => (
                    <li key={i} className="text-sm leading-relaxed text-content-secondary">{item}</li>
                ))}
            </ul>
        </div>
    );
}
