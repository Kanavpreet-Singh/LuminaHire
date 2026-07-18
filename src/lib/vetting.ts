import prisma from "@/lib/prisma";

export const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

// DB statuses that mean "a background run is in flight" and should be polled.
const RUNNING_STATUSES = ["RESEARCHING", "EVALUATING"] as const;

type PythonStatus = {
    phase: "PLANNING" | "RESEARCHING" | "AWAITING_RESEARCH_INPUT" | "EVALUATING" | "AWAITING_EVALUATION_APPROVAL" | "COMPLETED" | "FAILED";
    planner_output: any;
    research_results: any;
    evaluation: any;
    final_report: any;
    logs: string[];
    research_iterations: number;
    error: string | null;
};

function mergeLogs(existing: unknown, incoming: unknown): string[] {
    const a = Array.isArray(existing) ? (existing as string[]) : [];
    const b = Array.isArray(incoming) ? (incoming as string[]) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of [...a, ...b]) {
        if (typeof line !== "string") continue;
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
    }
    return out;
}

/**
 * Persist a COMPLETED result exactly once, using an updateMany status-guard as
 * an idempotency lock so concurrent pollers (detail page, list page, multiple
 * tabs) can't double-apply. Only the winning writer syncs the Application.
 * Returns true if this call was the one that claimed the transition.
 */
export async function syncCompletedResults(
    sessionId: string,
    applicationId: string,
    existingLogs: unknown,
    python: PythonStatus
): Promise<boolean> {
    const finalReport = python.final_report || {};
    const researchResults = python.research_results || [];
    const combinedLogs = mergeLogs(existingLogs, python.logs);

    const claim = await prisma.vettingSession.updateMany({
        where: { id: sessionId, status: { in: [...RUNNING_STATUSES] } },
        data: {
            status: "COMPLETED",
            researchResults,
            finalReport,
            logs: combinedLogs,
            // Backfill the plan for committee runs that started without one.
            ...(python.planner_output ? { researchPlan: python.planner_output } : {}),
            // Persist the evaluator's raw output too: non-HITL (committee) runs
            // never pause at AWAITING_EVALUATION_APPROVAL (the only other sync
            // that records it), and the completed session's stage-by-stage
            // review needs it. HITL runs pass evaluation: null here, keeping
            // whatever the earlier pause already persisted.
            ...(python.evaluation ? { evaluation: python.evaluation } : {}),
        },
    });

    if (claim.count !== 1) return false; // another poller already finalized it

    if (typeof finalReport.overall_fit_percentage === "number") {
        await prisma.application.update({
            where: { id: applicationId },
            data: {
                matchScore: finalReport.overall_fit_percentage,
                aiSummary: finalReport.summary || null,
                aiPros: finalReport.verified_skills || [],
                aiCons: finalReport.gaps_or_concerns || [],
                status: "HUMAN_APPROVED",
            },
        });
    }
    return true;
}

/**
 * Persist an AWAITING_RESEARCH_INPUT pause exactly once (same idempotent-claim
 * pattern as syncCompletedResults). Called once the first, plan-driven
 * research pass finishes and the pipeline pauses for human review.
 */
export async function syncAwaitingResearch(
    sessionId: string,
    existingLogs: unknown,
    python: PythonStatus
): Promise<boolean> {
    const claim = await prisma.vettingSession.updateMany({
        where: { id: sessionId, status: { in: [...RUNNING_STATUSES] } },
        data: {
            status: "AWAITING_RESEARCH_INPUT",
            researchResults: python.research_results || [],
            logs: mergeLogs(existingLogs, python.logs),
            ...(python.planner_output ? { researchPlan: python.planner_output } : {}),
        },
    });
    return claim.count === 1;
}

/**
 * Persist an AWAITING_EVALUATION_APPROVAL pause exactly once. Called once the
 * evaluator settles (evidence sufficient or loop exhausted) and the pipeline
 * pauses for human review before report writing.
 */
export async function syncAwaitingEvaluation(
    sessionId: string,
    existingLogs: unknown,
    python: PythonStatus
): Promise<boolean> {
    const claim = await prisma.vettingSession.updateMany({
        where: { id: sessionId, status: { in: [...RUNNING_STATUSES] } },
        data: {
            status: "AWAITING_EVALUATION_APPROVAL",
            evaluation: python.evaluation || {},
            researchResults: python.research_results || [],
            logs: mergeLogs(existingLogs, python.logs),
        },
    });
    return claim.count === 1;
}

/** Race-safe transition to FAILED with an appended log line. */
async function failSession(sessionId: string, existingLogs: unknown, message: string): Promise<void> {
    await prisma.vettingSession.updateMany({
        where: { id: sessionId, status: { in: [...RUNNING_STATUSES] } },
        data: { status: "FAILED", logs: mergeLogs(existingLogs, [message]) },
    });
}

type SessionWithApp = {
    id: string;
    applicationId: string;
    status: string;
    logs: unknown;
    researchPlan: unknown;
    batchId?: string | null;
};

/**
 * If a session's DB status says a background run is in flight, ask the Python
 * service for its live phase and persist any transition. This is the bridge
 * that advances RESEARCHING -> EVALUATING -> COMPLETED/FAILED for both the HITL
 * execute flow and batch committee runs (Next.js never gets a callback).
 *
 * Failure handling:
 *  - network error (Python briefly down/restarting): leave state untouched.
 *  - HTTP 404 (registry miss = Python restarted mid-run, state lost): mark FAILED.
 * Returns the possibly-refreshed full session row (re-queried after any write).
 */
export async function pollThroughPython<T extends SessionWithApp>(session: T): Promise<T> {
    if (!RUNNING_STATUSES.includes(session.status as any)) return session;

    let res: Response;
    try {
        res = await fetch(`${PYTHON_API_URL}/vet/status/${session.id}`, { cache: "no-store" });
    } catch {
        return session; // transient: Python momentarily unreachable
    }

    if (res.status === 404) {
        await failSession(
            session.id,
            session.logs,
            "Python service restarted mid-run; in-memory state was lost. Use Restart Session to re-run."
        );
        return refetch(session);
    }
    if (!res.ok) return session;

    let python: PythonStatus;
    try {
        python = (await res.json()) as PythonStatus;
    } catch {
        return session;
    }

    if (python.phase === "COMPLETED") {
        await syncCompletedResults(session.id, session.applicationId, session.logs, python);
        if (session.batchId) await maybeFinalizeBatch(session.batchId);
        return refetch(session);
    }
    if (python.phase === "FAILED") {
        await failSession(session.id, session.logs, python.error || "Pipeline failed.");
        if (session.batchId) await maybeFinalizeBatch(session.batchId);
        return refetch(session);
    }
    if (python.phase === "AWAITING_RESEARCH_INPUT") {
        await syncAwaitingResearch(session.id, session.logs, python);
        return refetch(session);
    }
    if (python.phase === "AWAITING_EVALUATION_APPROVAL") {
        await syncAwaitingEvaluation(session.id, session.logs, python);
        return refetch(session);
    }

    // Still running: persist a phase advance (e.g. RESEARCHING -> EVALUATING),
    // backfill the plan for committee runs, and checkpoint intermediate research
    // results so an interrupted run can resume without re-researching. Guarded so
    // we only touch rows that are still in a running state.
    if (python.phase === "EVALUATING" || python.phase === "RESEARCHING") {
        const data: Record<string, unknown> = {};
        if (python.phase !== session.status) data.status = python.phase;
        if (python.planner_output && !session.researchPlan) data.researchPlan = python.planner_output;
        if (Array.isArray(python.research_results) && python.research_results.length) {
            data.researchResults = python.research_results;
        }
        if (Array.isArray(python.logs) && python.logs.length) {
            data.logs = mergeLogs(session.logs, python.logs);
        }
        if (Object.keys(data).length > 0) {
            await prisma.vettingSession.updateMany({
                where: { id: session.id, status: { in: [...RUNNING_STATUSES] } },
                data,
            });
            return refetch(session);
        }
    }

    return session;
}

/** Re-read a session with the same relations the callers rely on. */
async function refetch<T extends SessionWithApp>(session: T): Promise<T> {
    const fresh = await prisma.vettingSession.findUnique({
        where: { id: session.id },
        include: { application: { include: { candidate: true, job: true } } },
    });
    return (fresh as unknown as T) ?? session;
}

/**
 * Finalize a batch once ALL its member sessions are terminal (COMPLETED/FAILED).
 * Ranks COMPLETED members by their pipeline's own overall_fit_percentage,
 * marks the top-N as winners (batchRank 1..N + Application AI_SHORTLISTED), and
 * flips the batch to COMPLETED. Idempotent: uses the same status-guarded
 * updateMany lock idiom as syncCompletedResults, so concurrent pollers can't
 * double-finalize -- only the writer that flips DISPATCHING/RUNNING -> COMPLETED
 * proceeds to write ranks. Safe to call unconditionally; a no-op if the batch
 * is already terminal or any member is still running.
 */
export async function maybeFinalizeBatch(batchId: string): Promise<void> {
    const members = await prisma.vettingSession.findMany({ where: { batchId } });
    if (members.length === 0) return;

    // Batch members are always AUTONOMOUS: they never pause at AWAITING_*, so
    // "all terminal" is exactly COMPLETED | FAILED for every member.
    const allTerminal = members.every((m) => m.status === "COMPLETED" || m.status === "FAILED");
    if (!allTerminal) return;

    const batch = await prisma.vettingBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.status === "COMPLETED" || batch.status === "FAILED") return;

    const fit = (m: (typeof members)[number]): number | null => {
        const v = (m.finalReport as any)?.overall_fit_percentage;
        return typeof v === "number" ? v : null;
    };
    const ranked = members
        .filter((m) => m.status === "COMPLETED" && fit(m) !== null)
        .sort((a, b) => (fit(b) as number) - (fit(a) as number));
    const top = ranked.slice(0, batch.targetHireCount);

    // Idempotency lock: only the caller that flips the batch terminal proceeds.
    const claim = await prisma.vettingBatch.updateMany({
        where: { id: batchId, status: { in: ["DISPATCHING", "RUNNING"] } },
        data: {
            status: "COMPLETED",
            finalizedAt: new Date(),
            topSessionIds: top.map((s) => s.id),
        },
    });
    if (claim.count !== 1) return; // another poller already finalized it

    if (top.length > 0) {
        await prisma.$transaction(
            top.map((s, i) =>
                prisma.vettingSession.update({ where: { id: s.id }, data: { batchRank: i + 1 } })
            )
        );
        await prisma.application.updateMany({
            where: { id: { in: top.map((s) => s.applicationId) } },
            data: { status: "AI_SHORTLISTED" },
        });
    }
}
