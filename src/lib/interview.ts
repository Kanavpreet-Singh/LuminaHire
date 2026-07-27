import crypto from "node:crypto";
import prisma from "@/lib/prisma";
import { PYTHON_API_URL, mergeUsage } from "@/lib/vetting";

/**
 * Shared server-side logic for Interview Kits (recruiter) and Practice
 * (candidate). Design: docs/interview-practice-design.md
 *
 * THE INVARIANT, restated here because this is the file most likely to be
 * edited by someone adding "just a bit of personalization":
 *
 *   Practice questions are resolved by jobId. Never by application, never by
 *   vetting session. A candidate must not be able to learn which of their
 *   resume claims came back CONTRADICTED and rehearse a cover story for it,
 *   and a recruiter's Interview Kit must not leak into a take-home.
 *
 * The only per-candidate step is orderQuestionsForCandidate() below, which
 * REORDERS an already-generated set using the candidate's own resume. It reads
 * nothing but data the candidate wrote about themselves, and it cannot change
 * what the questions say.
 */

export type PracticeRubric = {
    must_cover?: string[];
    strong_signals?: string[];
    common_mistakes?: string[];
};

// Categories that are always asked first regardless of competency match. The
// warmup exists to settle nerves and establish a baseline for how this person
// talks when comfortable — reordering it away from position 1 defeats it.
const PINNED_FIRST: string[] = ["ROLE_MOTIVATION"];

/** SHA-256 of resume text, used to cache the PERSONAL question across re-uploads. */
export function resumeHash(text: string | null | undefined): string | null {
    if (!text || !text.trim()) return null;
    return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

async function callPython(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${PYTHON_API_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${path} failed with ${res.status}`);
    }
    return res.json();
}

/**
 * Return the job's PUBLISHED practice set, generating and publishing version 1
 * on first request if none exists.
 *
 * Lazy generation is what makes this feature work with zero recruiter effort:
 * a candidate can practice against any open job, whether or not the recruiter
 * ever visited the practice tab. Cost stays O(jobs) because the result is
 * cached on the row — this is the ONLY place a set is generated.
 */
export async function getOrCreatePublishedPracticeSet(jobId: string, candidateId?: string | null) {
    // Shared questions plus, when a candidate is asking, their own PERSONAL
    // question — never another candidate's.
    const questionScope = {
        orderBy: { order: "asc" as const },
        where: candidateId
            ? { OR: [{ candidateId: null }, { candidateId }] }
            : { candidateId: null },
    };

    const existing = await prisma.practiceSet.findFirst({
        where: { jobId, status: "PUBLISHED" },
        orderBy: { version: "desc" },
        include: { questions: questionScope },
    });
    if (existing) return existing;

    const job = await prisma.jobPosting.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found");

    // NOTE: job only. There is no candidate or session argument to pass here,
    // and the Python endpoint's request model has no field to receive one.
    const generated = await callPython("/practice/generate", {
        job_id: jobId,
        job: { title: job.title, description: job.description, requirements: job.requirements },
    });

    const questions = Array.isArray(generated.questions) ? generated.questions : [];
    if (questions.length === 0) {
        throw new Error(generated.agent_error || "Practice set generation returned no questions");
    }

    // Highest existing version + 1, so a re-generation after an archive doesn't
    // collide on the (jobId, version) unique index.
    const latest = await prisma.practiceSet.findFirst({
        where: { jobId },
        orderBy: { version: "desc" },
        select: { version: true },
    });

    return prisma.practiceSet.create({
        data: {
            jobId,
            version: (latest?.version ?? 0) + 1,
            status: "PUBLISHED",
            generatedFrom: "JOB_ONLY",
            publishedAt: new Date(),
            usage: generated.usage ?? undefined,
            questions: {
                create: questions.map((q: any, i: number) => ({
                    order: i,
                    prompt: String(q.prompt || ""),
                    category: q.category || "BEHAVIORAL",
                    competency: String(q.competency || ""),
                    targetSeconds: Number(q.target_seconds) || 120,
                    rubric: q.rubric ?? undefined,
                    followUpHints: Array.isArray(q.follow_up_hints)
                        ? q.follow_up_hints.map((h: any) => String(h))
                        : [],
                })),
            },
        },
        include: { questions: questionScope },
    });
}

/**
 * Materialize the candidate's PERSONAL question as an answerable row in a set,
 * so it can be recorded against and scored like any other question.
 *
 * Scoped with `candidateId`, because it is generated from ONE candidate's own
 * resume — leaving it unscoped would show "walk me through the ingestion
 * rewrite you built at Acme" to every other applicant for that job.
 *
 * Idempotent, and non-fatal: this is a bonus on top of the job's set, so a
 * failure here must never stop a practice session from starting.
 */
export async function ensurePersonalQuestionRow(setId: string, candidate: {
    id: string;
    resumeText: string | null;
    personalQuestion: unknown;
    personalQuestionHash: string | null;
}) {
    try {
        const generated = await getOrCreatePersonalQuestion(candidate);
        if (!generated?.prompt) return null;

        const existing = await prisma.practiceQuestion.findFirst({
            where: { setId, candidateId: candidate.id, category: "PERSONAL" },
        });

        const data = {
            prompt: String(generated.prompt),
            competency: String(generated.competency || "signature project").slice(0, 120),
            targetSeconds: clampTarget(generated.target_seconds),
            rubric: (generated.rubric as any) ?? undefined,
            followUpHints: Array.isArray(generated.follow_up_hints)
                ? (generated.follow_up_hints as unknown[]).map(String)
                : [],
        };

        if (existing) {
            // The resume may have changed since this row was written.
            if (existing.prompt !== data.prompt) {
                return prisma.practiceQuestion.update({ where: { id: existing.id }, data });
            }
            return existing;
        }

        return prisma.practiceQuestion.create({
            data: {
                setId,
                candidateId: candidate.id,
                category: "PERSONAL",
                // Last in the running order: it is the question they are most
                // ready for, so it makes a better finish than an opener.
                order: 100,
                ...data,
            },
        });
    } catch (error) {
        console.error("Personal question row failed (non-fatal):", error);
        return null;
    }
}

function clampTarget(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 180;
    return Math.max(30, Math.min(300, Math.round(n)));
}

/**
 * The candidate's cached PERSONAL question, generated from their own resume
 * text only. Cached by resume hash so a lightly-edited re-upload that hashes
 * the same never burns another call — this costs one LLM call per candidate
 * per distinct resume, ever.
 *
 * Returns null (rather than throwing) when there's no resume or generation
 * fails: the PERSONAL question is a bonus on top of the job's set, and losing
 * it must never block a practice session from starting.
 */
export async function getOrCreatePersonalQuestion(candidate: {
    id: string;
    resumeText: string | null;
    personalQuestion: unknown;
    personalQuestionHash: string | null;
}) {
    const hash = resumeHash(candidate.resumeText);
    if (!hash) return null;

    if (candidate.personalQuestionHash === hash && candidate.personalQuestion) {
        return candidate.personalQuestion as Record<string, unknown>;
    }

    try {
        // Resume text only. A resume is something the candidate wrote about
        // themselves; a verdict on that resume is a different thing entirely
        // and must never reach this call.
        const generated = await callPython("/practice/personal-question", {
            resume_text: candidate.resumeText,
        });
        if (!generated?.prompt) return null;

        await prisma.candidate.update({
            where: { id: candidate.id },
            data: { personalQuestion: generated, personalQuestionHash: hash },
        });
        return generated as Record<string, unknown>;
    } catch (error) {
        console.error("Personal question generation failed (non-fatal):", error);
        return null;
    }
}

/**
 * Reorder a published set for one candidate: practice the competencies their
 * own background covers least, first.
 *
 * This is RETRIEVAL, not generation — it changes the order of questions that
 * already exist, and reads only the candidate's own resume text and skills. It
 * costs nothing and it structurally cannot leak a vetting session, because it
 * is never given one.
 *
 * The matcher is deliberately crude (token overlap against resume + skills)
 * rather than embedding-based. Ordering is a nicety: getting it slightly wrong
 * costs a candidate nothing, whereas an embedding call per question per
 * candidate would reintroduce the per-candidate cost this design exists to
 * avoid. Upgrade to pgvector here if ordering quality ever proves to matter.
 */
export function orderQuestionsForCandidate<T extends { category: string; competency: string; order: number }>(
    questions: T[],
    candidate: { resumeText: string | null; skills: string[] }
): T[] {
    const haystack = [
        (candidate.resumeText || "").toLowerCase(),
        (candidate.skills || []).join(" ").toLowerCase(),
    ].join(" ");

    const coverage = (competency: string): number => {
        const tokens = competency
            .toLowerCase()
            .split(/[^a-z0-9+#.]+/)
            .filter((t) => t.length > 2);
        if (tokens.length === 0) return 0.5; // unknown coverage sorts to the middle
        const hits = tokens.filter((t) => haystack.includes(t)).length;
        return hits / tokens.length;
    };

    return [...questions].sort((a, b) => {
        const aPinned = PINNED_FIRST.includes(a.category);
        const bPinned = PINNED_FIRST.includes(b.category);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (aPinned && bPinned) return a.order - b.order;

        const diff = coverage(a.competency) - coverage(b.competency);
        if (Math.abs(diff) > 0.01) return diff; // least-covered first
        return a.order - b.order;               // stable within a tie
    });
}

/**
 * Build the recruiter-visible payload for a shared mock interview.
 *
 * THIS IS AN ALLOWLIST, AND IT MUST STAY ONE. It names the fields that may be
 * shared rather than stripping the fields that may not, so a metric added next
 * quarter is invisible to recruiters BY DEFAULT — which is the correct
 * direction for this field to fail.
 *
 * Never shared: metrics, faceTimeline, delivery/presence scores, and every
 * delivery or presence coaching item. Those signals correlate with accent,
 * speech disabilities, ADHD-typical speech, autistic communication style,
 * cultural norms around eye contact, and whether someone owns a decent webcam.
 * As private coaching that's a candidate working on presentation. As a hiring
 * signal it's a disparate-impact engine with a dashboard.
 *
 * The recording itself is never included here — sharing media is a separate,
 * explicit toggle.
 */
export function toSharedPayload(mock: {
    id: string;
    startedAt: Date;
    completedAt: Date | null;
    dimensionScores: unknown;
    coaching: unknown;
    answers: {
        id: string;
        answerText: string | null;
        transcript: unknown;
        analysis: unknown;
        question: { prompt: string; category: string; competency: string };
    }[];
}) {
    const dims = (mock.dimensionScores || {}) as Record<string, number>;
    const coaching = (mock.coaching || {}) as Record<string, unknown>;

    return {
        id: mock.id,
        startedAt: mock.startedAt,
        completedAt: mock.completedAt,
        // Content only. `delivery` and `presence` are deliberately absent.
        scores: { content: dims.content ?? null, language: dims.language ?? null },
        summary: {
            narrative: typeof coaching.narrative === "string" ? coaching.narrative : "",
            strongestAnswer: typeof coaching.strongest_answer === "string" ? coaching.strongest_answer : "",
        },
        answers: mock.answers.map((a) => {
            const analysis = (a.analysis || {}) as Record<string, any>;
            const scores = (analysis.scores || {}) as Record<string, number>;
            const answerCoaching = (analysis.coaching || {}) as Record<string, any>;
            const transcript = (a.transcript || {}) as Record<string, any>;
            return {
                question: a.question.prompt,
                category: a.question.category,
                competency: a.question.competency,
                // What they said. In TEXT mode this is what they typed; in
                // AUDIO/VIDEO it's the ASR text — never the recording.
                answerText: a.answerText ?? (typeof transcript.text === "string" ? transcript.text : null),
                contentScore: scores.content ?? null,
                contentFeedback: answerCoaching.content_feedback ?? null,
            };
        }),
    };
}

/**
 * Judge one answer and persist the result. Shared by the answer-submit route
 * and any future re-analysis path.
 */
export async function judgeAndPersistAnswer(answerId: string, jobTitle: string) {
    const answer = await prisma.mockAnswer.findUnique({
        where: { id: answerId },
        include: { question: true, mockInterview: true },
    });
    if (!answer) throw new Error("Answer not found");

    await prisma.mockAnswer.update({
        where: { id: answerId },
        data: { status: "ANALYZING", analysisAttempts: { increment: 1 } },
    });

    try {
        const result = await callPython("/mock/judge-answer", {
            answer_id: answerId,
            question: {
                prompt: answer.question.prompt,
                category: answer.question.category,
                target_seconds: answer.question.targetSeconds,
                rubric: answer.question.rubric ?? {},
            },
            answer_text:
                answer.answerText ?? ((answer.transcript as any)?.text ?? ""),
            metrics: answer.metrics ?? null,
            mode: answer.mockInterview.mode,
            accessibility_mode: answer.mockInterview.accessibilityMode,
            job_title: jobTitle,
        });

        return await prisma.mockAnswer.update({
            where: { id: answerId },
            data: {
                status: "ANALYZED",
                score: typeof result.overall === "number" ? result.overall : null,
                analysis: {
                    scores: result.scores ?? {},
                    weights: result.weights ?? {},
                    band_detail: result.band_detail ?? {},
                    coaching: result.coaching ?? {},
                    ...(result.agent_error ? { agent_error: result.agent_error } : {}),
                },
                errorMessage: result.agent_error ?? null,
            },
            include: { question: true },
        });
    } catch (error: any) {
        // A scoring outage must not destroy the answer. Leaving it FAILED with
        // its text/media intact keeps it fully retryable, which is the property
        // that makes this pipeline's crash story better than the vetting
        // pipeline's: analysis is a pure function of durable inputs.
        await prisma.mockAnswer.update({
            where: { id: answerId },
            data: { status: "FAILED", errorMessage: String(error?.message || error).slice(0, 500) },
        });
        throw error;
    }
}

/**
 * Dispatch background media analysis for a recorded answer.
 *
 * The face track is forwarded but NEVER STORED: Python aggregates it into
 * metrics plus a 1 Hz timeline and discards the per-frame rows. Persisting
 * per-frame facial geometry would create a biometric dataset with real
 * obligations attached and no product use the aggregate doesn't already serve.
 */
export async function dispatchMediaAnalysis(
    answerId: string,
    opts: {
        mediaUrl: string | null;
        question: { prompt: string; category: string; targetSeconds: number; rubric: unknown };
        faceTrack?: unknown[] | null;
        mode: string;
        accessibilityMode: boolean;
        jobTitle: string;
        durationSeconds?: number | null;
    }
) {
    await prisma.mockAnswer.update({
        where: { id: answerId },
        data: { status: "ANALYZING", analysisAttempts: { increment: 1 } },
    });

    const res = await fetch(`${PYTHON_API_URL}/mock/analyze-async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            answer_id: answerId,
            media_url: opts.mediaUrl,
            question: {
                prompt: opts.question.prompt,
                category: opts.question.category,
                target_seconds: opts.question.targetSeconds,
                rubric: opts.question.rubric ?? {},
            },
            face_track: opts.faceTrack ?? null,
            mode: opts.mode,
            accessibility_mode: opts.accessibilityMode,
            job_title: opts.jobTitle,
            duration_seconds: opts.durationSeconds ?? null,
        }),
    });

    // 409 means an identical run is already in flight — harmless, and treating
    // it as an error would surface a scary message for a double-click.
    if (!res.ok && res.status !== 409) {
        const text = await res.text();
        await prisma.mockAnswer.update({
            where: { id: answerId },
            data: { status: "FAILED", errorMessage: (text || "Dispatch failed").slice(0, 500) },
        });
        throw new Error(text || "Could not start analysis");
    }
}

/** Answer statuses that mean a background analysis should be polled. */
const ANALYZING_STATUSES = ["ANALYZING"] as const;

/**
 * Advance any in-flight media analyses for a mock interview by polling Python
 * on read — the same poll-through pattern src/lib/vetting.ts uses, because
 * there is no queue and no callback channel in this deployment.
 *
 * THE 404 CASE IS HANDLED DIFFERENTLY HERE THAN IN VETTING, and that difference
 * is the point. A registry miss mid-vetting means unrecoverable agent state is
 * gone, so the session is marked FAILED. Media analysis is a pure function of
 * durable inputs — the blob, the rubric, the face-track aggregate — so a
 * registry wipe just means re-dispatching. `analysisAttempts` bounds that, so a
 * genuinely poisonous input (corrupt container, zero-length audio) can't
 * re-dispatch forever.
 */
export async function pollThroughMediaAnalyses(mockId: string, jobTitle: string): Promise<boolean> {
    const pending = await prisma.mockAnswer.findMany({
        where: { mockInterviewId: mockId, status: { in: [...ANALYZING_STATUSES] } },
        include: { question: true, mockInterview: true },
    });
    if (pending.length === 0) return false;

    let changed = false;

    for (const answer of pending) {
        let payload: any;
        try {
            const res = await fetch(`${PYTHON_API_URL}/mock/status/${answer.id}`);

            if (res.status === 404) {
                if (answer.analysisAttempts < 2) {
                    // Nothing was lost. Re-run it from the durable inputs.
                    await dispatchMediaAnalysis(answer.id, {
                        mediaUrl: answer.mediaUrl,
                        question: {
                            prompt: answer.question.prompt,
                            category: answer.question.category,
                            targetSeconds: answer.question.targetSeconds,
                            rubric: answer.question.rubric,
                        },
                        faceTrack: null, // aggregate already computed, or genuinely gone
                        mode: answer.mockInterview.mode,
                        accessibilityMode: answer.mockInterview.accessibilityMode,
                        jobTitle,
                        durationSeconds: answer.durationSeconds,
                    });
                } else {
                    await prisma.mockAnswer.update({
                        where: { id: answer.id },
                        data: {
                            status: "FAILED",
                            errorMessage:
                                "Analysis was interrupted and could not be recovered. Your recording is safe — retry scoring.",
                        },
                    });
                }
                changed = true;
                continue;
            }

            if (!res.ok) continue;
            payload = await res.json();
        } catch {
            // Python restarting or unreachable. Leave state untouched and retry
            // on the next read, exactly as pollThroughPython does.
            continue;
        }

        if (payload.phase === "COMPLETED" && payload.result) {
            await persistAnalysis(answer.id, payload.result);
            changed = true;
        } else if (payload.phase === "FAILED") {
            await prisma.mockAnswer.update({
                where: { id: answer.id },
                data: { status: "FAILED", errorMessage: String(payload.error || "Analysis failed").slice(0, 500) },
            });
            changed = true;
        }
    }

    return changed;
}

/** Persist a completed media analysis onto its answer row. */
export async function persistAnalysis(answerId: string, result: any) {
    await prisma.mockAnswer.update({
        where: { id: answerId },
        data: {
            status: "ANALYZED",
            score: typeof result.overall === "number" ? result.overall : null,
            transcript: result.transcript ?? undefined,
            metrics: result.metrics ?? undefined,
            // 1 Hz downsample only. The raw ~15 Hz track is never persisted.
            faceTimeline: result.face_timeline ?? undefined,
            analysis: {
                scores: result.scores ?? {},
                weights: result.weights ?? {},
                band_detail: result.band_detail ?? {},
                coaching: result.coaching ?? {},
                degraded: result.degraded ?? [],
                ...(result.agent_error ? { agent_error: result.agent_error } : {}),
            },
            errorMessage: result.agent_error ?? null,
        },
    });
}

export { PYTHON_API_URL, mergeUsage, callPython };
