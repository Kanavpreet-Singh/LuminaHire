import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getJobMatches } from "@/lib/matches";
import { PYTHON_API_URL, maybeFinalizeBatch } from "@/lib/vetting";

const MAX_TOP_N = 10;
const MAX_BATCH_POOL_SIZE = Number(process.env.BATCH_POOL_CAP) || 20;
const DEFAULT_THRESHOLD = 50;

const TERMINAL_SESSION_STATUSES = ["COMPLETED", "FAILED"];

/**
 * Start a batch "Hiring Committee" run for a job: take every candidate above a
 * semantic-similarity threshold (capped at MAX_BATCH_POOL_SIZE), run the FULL
 * autonomous pipeline for each, and (once all finish, via poll-through +
 * maybeFinalizeBatch) rank the top-N by the pipeline's OWN fit score.
 *
 * Always-re-run-fresh: any pre-existing terminal session for a pooled candidate
 * is deleted and re-run so its score reflects this batch's priority
 * instructions. Non-terminal sessions (mid-flight elsewhere) are left alone.
 *
 * Returns near-instantly; each per-candidate dispatch is a fire-and-forget POST
 * to the Python service that returns 202 immediately.
 */
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }
        const recruiterId = session.user.id!;

        const body = await req.json().catch(() => ({}));
        const jobId: string | undefined = body.jobId;
        if (!jobId) return new NextResponse("Missing jobId", { status: 400 });

        const targetHireCount = Math.max(1, Math.min(Number(body.targetHireCount) || 1, MAX_TOP_N));
        const matchThreshold = Math.max(0, Math.min(Number(body.matchThreshold ?? DEFAULT_THRESHOLD), 100));
        const recruiterInstructions =
            typeof body.recruiterInstructions === "string" && body.recruiterInstructions.trim()
                ? body.recruiterInstructions.trim()
                : null;

        const job = await prisma.jobPosting.findFirst({
            where: { id: jobId, recruiterId: session.user.id },
        });
        if (!job) {
            return new NextResponse("Job posting not found or not owned by you", { status: 404 });
        }

        // Friendly early-exit for an already-running batch (the partial unique
        // index is the hard race backstop below).
        const active = await prisma.vettingBatch.findFirst({
            where: { jobId, status: { in: ["DISPATCHING", "RUNNING"] } },
        });
        if (active) {
            return NextResponse.json(
                { error: "A batch is already running for this job.", existingBatchId: active.id },
                { status: 409 }
            );
        }

        // Rank all candidates by pgvector similarity, keep those over threshold,
        // cap the pool. topN is applied LATER (post-pipeline), not here.
        const matches = await getJobMatches(jobId);
        const pool = matches
            .filter((m) => (m.matchScore ?? 0) > matchThreshold)
            .slice(0, MAX_BATCH_POOL_SIZE);

        // Create the batch row (partial unique index enforces one active/job).
        let batch;
        try {
            batch = await prisma.vettingBatch.create({
                data: {
                    jobId,
                    recruiterId,
                    targetHireCount,
                    matchThreshold,
                    recruiterInstructions,
                    status: "DISPATCHING",
                    poolSize: pool.length,
                },
            });
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
                const existing = await prisma.vettingBatch.findFirst({
                    where: { jobId, status: { in: ["DISPATCHING", "RUNNING"] } },
                });
                return NextResponse.json(
                    { error: "A batch is already running for this job.", existingBatchId: existing?.id },
                    { status: 409 }
                );
            }
            throw e;
        }

        if (pool.length === 0) {
            await prisma.vettingBatch.update({
                where: { id: batch.id },
                data: {
                    status: "FAILED",
                    errorMessage: `No candidates above ${matchThreshold}% similarity. Lower the threshold or ensure candidates have uploaded resumes.`,
                },
            });
            return NextResponse.json({
                batchId: batch.id,
                poolSize: 0,
                dispatched: 0,
                skipped: 0,
                message: "No candidates crossed the threshold.",
            });
        }

        let dispatched = 0;
        let skipped = 0;

        for (const cand of pool) {
            // Upsert the Application.
            let application = await prisma.application.findUnique({
                where: { candidateId_jobId: { candidateId: cand.id, jobId } },
            });
            if (!application) {
                application = await prisma.application.create({
                    data: { candidateId: cand.id, jobId, status: "AI_PROCESSING" },
                });
            }

            const existing = await prisma.vettingSession.findUnique({
                where: { applicationId: application.id },
            });
            if (existing) {
                if (!TERMINAL_SESSION_STATUSES.includes(existing.status)) {
                    // Mid-flight in some other context -- don't disturb it.
                    skipped++;
                    continue;
                }
                // Always-re-run-fresh: drop the stale terminal session.
                await prisma.vettingSession.delete({ where: { id: existing.id } });
            }

            const vettingSession = await prisma.vettingSession.create({
                data: {
                    applicationId: application.id,
                    status: "RESEARCHING",
                    pipelineMode: "AUTONOMOUS",
                    batchId: batch.id,
                    recruiterInstructions,
                    logs: ["Hiring Committee batch run queued."],
                },
            });

            try {
                const dispatch = await fetch(`${PYTHON_API_URL}/vet/run-full-async`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        session_id: vettingSession.id,
                        job: {
                            title: job.title,
                            description: job.description,
                            requirements: job.requirements,
                            recruiter_instructions: recruiterInstructions,
                        },
                        candidate: {
                            name: cand.name,
                            email: cand.email,
                            resume_text: cand.resumeText,
                            linkedin_url: cand.linkedinUrl,
                            github_url: cand.githubUrl,
                        },
                    }),
                });
                if (!dispatch.ok && dispatch.status !== 409) {
                    await prisma.vettingSession.update({
                        where: { id: vettingSession.id },
                        data: { status: "FAILED", logs: ["Failed to start batch pipeline (dispatch error)."] },
                    });
                }
            } catch {
                await prisma.vettingSession.update({
                    where: { id: vettingSession.id },
                    data: { status: "FAILED", logs: ["Python service unreachable at dispatch."] },
                });
            }
            dispatched++;
        }

        if (dispatched === 0) {
            // Every candidate was skipped (all mid-flight in other contexts) --
            // this batch owns zero member sessions, so poll-through /
            // maybeFinalizeBatch (which no-ops on an empty member set) would
            // never advance it. Close it out directly instead of leaving it
            // stuck at RUNNING.
            await prisma.vettingBatch.update({
                where: { id: batch.id },
                data: {
                    status: "COMPLETED",
                    finalizedAt: new Date(),
                    topSessionIds: [],
                    dispatchedCount: 0,
                    skippedCount: skipped,
                    errorMessage: "All pooled candidates already had an in-progress session; nothing new was dispatched.",
                },
            });
            return NextResponse.json({ batchId: batch.id, poolSize: pool.length, dispatched: 0, skipped });
        }

        await prisma.vettingBatch.update({
            where: { id: batch.id },
            data: { status: "RUNNING", dispatchedCount: dispatched, skippedCount: skipped },
        });

        // If every dispatched session failed synchronously (Python unreachable),
        // they're all terminal already -- finalize now rather than waiting for a
        // poll. No-op when any session is still running.
        await maybeFinalizeBatch(batch.id);

        return NextResponse.json({
            batchId: batch.id,
            poolSize: pool.length,
            dispatched,
            skipped,
        });
    } catch (error: any) {
        console.error("Error starting hiring committee batch:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
