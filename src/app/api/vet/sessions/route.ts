import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { pollThroughPython } from "@/lib/vetting";

const MAX_CONCURRENT_POLLS = 15;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Internal Server Error";
}

/**
 * List this recruiter's vetting sessions (optionally filtered by ?jobId=), and
 * poll-through any in-flight runs so a batch committee's statuses advance live
 * while the client watches this endpoint. The server-component list page can't
 * poll Python on its own — this is what makes the live list work.
 */
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as { role?: string }).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const jobId = searchParams.get("jobId") || undefined;

        const sessions = await prisma.vettingSession.findMany({
            where: {
                application: {
                    job: {
                        recruiterId: session.user.id,
                        ...(jobId ? { id: jobId } : {}),
                    },
                },
            },
            include: {
                application: { include: { candidate: true, job: true } },
            },
            orderBy: { updatedAt: "desc" },
        });

        // Advance any in-flight runs (bounded concurrency to avoid a poll storm).
        const running = sessions.filter((s) => s.status === "RESEARCHING" || s.status === "EVALUATING");
        for (let i = 0; i < running.length; i += MAX_CONCURRENT_POLLS) {
            const batch = running.slice(i, i + MAX_CONCURRENT_POLLS);
            await Promise.all(batch.map((s) => pollThroughPython(s)));
        }

        // Re-read so the response reflects any transitions just persisted.
        const fresh = await prisma.vettingSession.findMany({
            where: {
                application: {
                    job: {
                        recruiterId: session.user.id,
                        ...(jobId ? { id: jobId } : {}),
                    },
                },
            },
            include: {
                application: { include: { candidate: true, job: true } },
            },
            orderBy: { updatedAt: "desc" },
        });

        const batches = await prisma.vettingBatch.findMany({
            where: {
                recruiterId: session.user.id,
                ...(jobId ? { jobId } : {}),
            },
            include: {
                job: true,
                sessions: {
                    include: {
                        application: { include: { candidate: true, job: true } },
                    },
                    orderBy: { updatedAt: "desc" },
                },
            },
            orderBy: { updatedAt: "desc" },
        });

        return NextResponse.json({
            sessions: fresh.filter((vs) => !vs.batchId).map((vs) => ({
                id: vs.id,
                status: vs.status,
                updatedAt: vs.updatedAt,
                finalReport: vs.finalReport,
                candidateName: vs.application.candidate.name,
                jobId: vs.application.job.id,
                jobTitle: vs.application.job.title,
            })),
            batches: batches.map((batch) => ({
                id: batch.id,
                jobId: batch.jobId,
                jobTitle: batch.job.title,
                status: batch.status,
                targetHireCount: batch.targetHireCount,
                matchThreshold: batch.matchThreshold,
                poolSize: batch.poolSize,
                dispatchedCount: batch.dispatchedCount,
                skippedCount: batch.skippedCount,
                createdAt: batch.createdAt,
                updatedAt: batch.updatedAt,
                finalizedAt: batch.finalizedAt,
                errorMessage: batch.errorMessage,
                members: batch.sessions.map((vs) => ({
                    id: vs.id,
                    status: vs.status,
                    updatedAt: vs.updatedAt,
                    finalReport: vs.finalReport,
                    candidateName: vs.application.candidate.name,
                    candidateEmail: vs.application.candidate.email,
                    jobId: vs.application.job.id,
                    jobTitle: vs.application.job.title,
                    batchRank: vs.batchRank,
                })),
            })),
        });
    } catch (error: unknown) {
        console.error("Error listing vetting sessions:", error);
        return new NextResponse(getErrorMessage(error), { status: 500 });
    }
}
