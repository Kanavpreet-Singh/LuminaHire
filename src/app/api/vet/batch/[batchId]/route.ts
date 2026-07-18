import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { pollThroughPython, maybeFinalizeBatch } from "@/lib/vetting";

const MAX_CONCURRENT_POLLS = 15;

/**
 * Poll a batch's live status: advances every in-flight member session via
 * poll-through (bounded concurrency, same pattern as /api/vet/sessions), then
 * finalizes the batch if all members are now terminal, and returns the batch +
 * a per-member roll-up sorted winners-first.
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ batchId: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const { batchId } = await params;

        const batch = await prisma.vettingBatch.findUnique({
            where: { id: batchId },
            include: { job: true },
        });
        if (!batch) return new NextResponse("Batch not found", { status: 404 });
        if (batch.recruiterId !== session.user.id) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        let members = await prisma.vettingSession.findMany({
            where: { batchId },
            include: { application: { include: { candidate: true, job: true } } },
        });

        // Advance any in-flight member sessions (bounded to avoid a poll storm).
        const running = members.filter((s) => s.status === "RESEARCHING" || s.status === "EVALUATING");
        for (let i = 0; i < running.length; i += MAX_CONCURRENT_POLLS) {
            const chunk = running.slice(i, i + MAX_CONCURRENT_POLLS);
            await Promise.all(chunk.map((s) => pollThroughPython(s as any)));
        }

        // Finalize once all members are terminal (idempotent; no-op otherwise).
        await maybeFinalizeBatch(batchId);

        // Re-read after any writes.
        const freshBatch = await prisma.vettingBatch.findUnique({ where: { id: batchId } });
        members = await prisma.vettingSession.findMany({
            where: { batchId },
            include: { application: { include: { candidate: true, job: true } } },
        });

        const memberRollup = members
            .map((m) => ({
                sessionId: m.id,
                candidateName: m.application.candidate.name,
                candidateEmail: m.application.candidate.email,
                status: m.status,
                overallFitPercentage:
                    typeof (m.finalReport as any)?.overall_fit_percentage === "number"
                        ? (m.finalReport as any).overall_fit_percentage
                        : null,
                verdict: (m.finalReport as any)?.verdict ?? null,
                batchRank: m.batchRank,
            }))
            .sort((a, b) => {
                // Winners first (batchRank asc, nulls last), then fit desc.
                if (a.batchRank != null && b.batchRank != null) return a.batchRank - b.batchRank;
                if (a.batchRank != null) return -1;
                if (b.batchRank != null) return 1;
                return (b.overallFitPercentage ?? -1) - (a.overallFitPercentage ?? -1);
            });

        return NextResponse.json({
            batch: {
                id: freshBatch!.id,
                jobId: freshBatch!.jobId,
                jobTitle: batch.job.title,
                status: freshBatch!.status,
                targetHireCount: freshBatch!.targetHireCount,
                matchThreshold: freshBatch!.matchThreshold,
                recruiterInstructions: freshBatch!.recruiterInstructions,
                poolSize: freshBatch!.poolSize,
                dispatchedCount: freshBatch!.dispatchedCount,
                skippedCount: freshBatch!.skippedCount,
                errorMessage: freshBatch!.errorMessage,
                finalizedAt: freshBatch!.finalizedAt,
            },
            members: memberRollup,
        });
    } catch (error: any) {
        console.error("Error polling batch:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
