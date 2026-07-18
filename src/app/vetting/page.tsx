import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import VettingSessionsClient from "./VettingSessionsClient";

interface VettingSessionsListProps {
    searchParams?: Promise<{ jobId?: string }>;
}

export default async function VettingSessionsList({ searchParams }: VettingSessionsListProps) {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    if ((session.user as { role?: string }).role !== "RECRUITER") {
        redirect("/profile");
    }

    const resolvedSearchParams = await searchParams;
    const selectedJobId = resolvedSearchParams?.jobId || "";

    const jobs = await prisma.jobPosting.findMany({
        where: { recruiterId: session.user.id },
        select: { id: true, title: true },
        orderBy: { updatedAt: "desc" },
    });

    const vettingSessions = await prisma.vettingSession.findMany({
        where: {
            application: {
                job: {
                    recruiterId: session.user.id,
                    ...(selectedJobId ? { id: selectedJobId } : {}),
                },
            },
        },
        include: {
            application: {
                include: {
                    candidate: true,
                    job: true,
                },
            },
        },
        orderBy: {
            updatedAt: "desc",
        },
    });

    const batches = await prisma.vettingBatch.findMany({
        where: {
            recruiterId: session.user.id,
            ...(selectedJobId ? { jobId: selectedJobId } : {}),
        },
        include: {
            job: true,
            sessions: {
                include: {
                    application: {
                        include: {
                            candidate: true,
                            job: true,
                        },
                    },
                },
                orderBy: { updatedAt: "desc" },
            },
        },
        orderBy: { updatedAt: "desc" },
    });

    const initialSessions = vettingSessions.filter((vs) => !vs.batchId).map((vs) => ({
        id: vs.id,
        status: vs.status,
        updatedAt: vs.updatedAt.toISOString(),
        finalReport: vs.finalReport,
        candidateName: vs.application.candidate.name,
        jobId: vs.application.job.id,
        jobTitle: vs.application.job.title,
    }));

    const initialBatches = batches.map((batch) => ({
        id: batch.id,
        jobId: batch.jobId,
        jobTitle: batch.job.title,
        status: batch.status,
        targetHireCount: batch.targetHireCount,
        matchThreshold: batch.matchThreshold,
        poolSize: batch.poolSize,
        dispatchedCount: batch.dispatchedCount,
        skippedCount: batch.skippedCount,
        createdAt: batch.createdAt.toISOString(),
        updatedAt: batch.updatedAt.toISOString(),
        finalizedAt: batch.finalizedAt?.toISOString() || null,
        errorMessage: batch.errorMessage,
        members: batch.sessions.map((vs) => ({
            id: vs.id,
            status: vs.status,
            updatedAt: vs.updatedAt.toISOString(),
            finalReport: vs.finalReport,
            candidateName: vs.application.candidate.name,
            candidateEmail: vs.application.candidate.email,
            jobId: vs.application.job.id,
            jobTitle: vs.application.job.title,
            batchRank: vs.batchRank,
        })),
    }));

    return (
        <div className="flex-1 bg-surface-primary py-12 px-6 sm:px-12 relative overflow-hidden">
            <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
                <div className="absolute top-[-10%] right-[-5%] w-96 h-96 bg-brand-500/20 rounded-full blur-[100px] animate-pulse"></div>
                <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px]"></div>
            </div>

            <div className="max-w-6xl mx-auto space-y-10 relative z-10">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                    <div>
                        <span className="text-xs font-bold text-brand-500 uppercase tracking-widest">AI Agent Management</span>
                        <h1 className="text-2xl sm:text-3xl font-extrabold text-content-primary mt-1">Recruit Sessions (HITL)</h1>
                        <p className="text-content-secondary mt-1 text-sm">Review, edit, and monitor AI agent research plans and execution states.</p>
                    </div>
                    <Link href="/dashboard" className="px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl font-bold transition-all shadow-sm text-sm">
                        Back to Dashboard
                    </Link>
                </div>

                <VettingSessionsClient
                    initialSessions={initialSessions}
                    initialBatches={initialBatches}
                    jobs={jobs}
                    initialJobId={selectedJobId}
                />
            </div>
        </div>
    );
}
