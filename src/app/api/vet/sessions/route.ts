import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { pollThroughPython } from "@/lib/vetting";

const MAX_CONCURRENT_POLLS = 15;

/**
 * List this recruiter's vetting sessions (optionally filtered by ?jobId=), and
 * poll-through any in-flight runs so a batch committee's statuses advance live
 * while the client watches this endpoint. The server-component list page can't
 * poll Python on its own — this is what makes the live list work.
 */
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || (session.user as any).role !== "RECRUITER") {
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
            await Promise.all(batch.map((s) => pollThroughPython(s as any)));
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

        return NextResponse.json({
            sessions: fresh.map((vs) => ({
                id: vs.id,
                status: vs.status,
                updatedAt: vs.updatedAt,
                finalReport: vs.finalReport,
                candidateName: vs.application.candidate.name,
                jobId: vs.application.job.id,
                jobTitle: vs.application.job.title,
            })),
        });
    } catch (error: any) {
        console.error("Error listing vetting sessions:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
