import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getJobMatches } from "@/lib/matches";
import { PYTHON_API_URL } from "@/lib/vetting";

const MAX_TOP_N = 10;

/**
 * Batch "Run Hiring Committee": auto-vets the top-N pgvector-matched candidates
 * for a job with no HITL plan-editing step. Creates an Application + a
 * VettingSession (status RESEARCHING) per candidate and dispatches a full
 * background pipeline for each. Progress is surfaced by poll-through on the
 * session list / detail routes.
 */
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const jobId: string | undefined = body.jobId;
        const requestedTopN = Number(body.topN) || 5;
        const topN = Math.max(1, Math.min(requestedTopN, MAX_TOP_N));

        if (!jobId) {
            return new NextResponse("Missing jobId", { status: 400 });
        }

        const job = await prisma.jobPosting.findFirst({
            where: { id: jobId, recruiterId: session.user.id }
        });
        if (!job) {
            return new NextResponse("Job posting not found or not owned by you", { status: 404 });
        }

        // Rank candidates and take the top-N with a non-zero match.
        const matches = await getJobMatches(jobId);
        const shortlist = matches.filter((m) => (m.matchScore ?? 0) > 0).slice(0, topN);

        if (shortlist.length === 0) {
            return NextResponse.json({
                jobId,
                jobTitle: job.title,
                dispatched: 0,
                sessions: [],
                message: "No candidates with a positive match score. Ensure candidates have uploaded resumes.",
            });
        }

        const results: Array<{
            sessionId: string | null;
            candidateId: string;
            candidateName: string;
            matchScore: number | null;
            skipped: boolean;
            reason?: string;
        }> = [];

        for (const cand of shortlist) {
            // Upsert the Application.
            let application = await prisma.application.findUnique({
                where: { candidateId_jobId: { candidateId: cand.id, jobId } }
            });
            if (!application) {
                application = await prisma.application.create({
                    data: { candidateId: cand.id, jobId, status: "AI_PROCESSING" }
                });
            }

            // Skip if a non-FAILED session already exists; recreate FAILED ones.
            const existing = await prisma.vettingSession.findUnique({
                where: { applicationId: application.id }
            });
            if (existing) {
                if (existing.status !== "FAILED") {
                    results.push({
                        sessionId: existing.id,
                        candidateId: cand.id,
                        candidateName: cand.name,
                        matchScore: cand.matchScore,
                        skipped: true,
                        reason: `Already has a ${existing.status.toLowerCase()} session`,
                    });
                    continue;
                }
                await prisma.vettingSession.delete({ where: { id: existing.id } });
            }

            // Create the session already in RESEARCHING (no HITL). The plan is
            // backfilled by poll-through once the planner runs in Python.
            const vettingSession = await prisma.vettingSession.create({
                data: {
                    applicationId: application.id,
                    status: "RESEARCHING",
                    pipelineMode: "AUTONOMOUS",
                    researchPlan: undefined,
                    logs: ["Hiring Committee run queued."],
                }
            });

            // Dispatch the full background pipeline.
            try {
                const dispatch = await fetch(`${PYTHON_API_URL}/vet/run-full-async`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        session_id: vettingSession.id,
                        job: {
                            title: job.title,
                            description: job.description,
                            requirements: job.requirements
                        },
                        candidate: {
                            name: cand.name,
                            email: cand.email,
                            resume_text: cand.resumeText,
                            linkedin_url: cand.linkedinUrl,
                            github_url: cand.githubUrl
                        }
                    })
                });
                if (!dispatch.ok && dispatch.status !== 409) {
                    await prisma.vettingSession.update({
                        where: { id: vettingSession.id },
                        data: { status: "FAILED", logs: ["Failed to start committee pipeline."] }
                    });
                    results.push({
                        sessionId: vettingSession.id,
                        candidateId: cand.id,
                        candidateName: cand.name,
                        matchScore: cand.matchScore,
                        skipped: false,
                        reason: "dispatch failed",
                    });
                    continue;
                }
            } catch {
                await prisma.vettingSession.update({
                    where: { id: vettingSession.id },
                    data: { status: "FAILED", logs: ["Python service unreachable."] }
                });
                results.push({
                    sessionId: vettingSession.id,
                    candidateId: cand.id,
                    candidateName: cand.name,
                    matchScore: cand.matchScore,
                    skipped: false,
                    reason: "service unreachable",
                });
                continue;
            }

            results.push({
                sessionId: vettingSession.id,
                candidateId: cand.id,
                candidateName: cand.name,
                matchScore: cand.matchScore,
                skipped: false,
            });
        }

        const dispatched = results.filter((r) => !r.skipped).length;
        const skipped = results.filter((r) => r.skipped).length;

        return NextResponse.json({
            jobId,
            jobTitle: job.title,
            dispatched,
            skipped,
            sessions: results,
        });
    } catch (error: any) {
        console.error("Error running hiring committee:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
