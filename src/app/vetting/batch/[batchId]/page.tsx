"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";

interface BatchMember {
    sessionId: string;
    candidateName: string;
    candidateEmail: string;
    status: string;
    overallFitPercentage: number | null;
    verdict: string | null;
    batchRank: number | null;
}

interface BatchData {
    id: string;
    jobId: string;
    jobTitle: string;
    status: "DISPATCHING" | "RUNNING" | "COMPLETED" | "FAILED";
    targetHireCount: number;
    matchThreshold: number;
    recruiterInstructions: string | null;
    poolSize: number;
    dispatchedCount: number;
    skippedCount: number;
    errorMessage: string | null;
    finalizedAt: string | null;
}

export default function BatchResultsPage({ params }: { params: Promise<{ batchId: string }> }) {
    const { batchId } = use(params);

    const [batch, setBatch] = useState<BatchData | null>(null);
    const [members, setMembers] = useState<BatchMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const load = async () => {
        try {
            const res = await fetch(`/api/vet/batch/${batchId}`, { cache: "no-store" });
            if (!res.ok) {
                setError((await res.text()) || "Failed to load batch");
                return;
            }
            const data = await res.json();
            setBatch(data.batch);
            setMembers(data.members || []);
            setError("");
        } catch {
            setError("Could not reach the server.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [batchId]);

    // Poll while the batch is still working. ~2.5s (slower than the single-
    // session 1.5s, since each poll fans out to all member sessions).
    useEffect(() => {
        if (batch?.status !== "RUNNING" && batch?.status !== "DISPATCHING") return;
        const interval = setInterval(load, 2500);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [batch?.status]);

    if (loading) {
        return (
            <div className="flex-1 bg-surface-primary flex flex-col justify-center items-center p-8 space-y-3">
                <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-content-secondary text-sm font-semibold">Loading batch...</span>
            </div>
        );
    }

    if (error && !batch) {
        return (
            <div className="flex-1 bg-surface-primary flex flex-col justify-center items-center p-8 space-y-4">
                <div className="p-6 bg-rose-500/10 border border-rose-500/20 text-rose-600 rounded-2xl text-center max-w-md">
                    <h2 className="text-xl font-bold mb-2">Error Loading Batch</h2>
                    <p className="text-sm">{error}</p>
                </div>
                <Link href="/vetting" className="px-5 py-2.5 bg-surface-tertiary border border-border-default rounded-xl font-bold text-sm text-content-secondary hover:bg-surface-secondary">
                    Back to Sessions
                </Link>
            </div>
        );
    }

    if (!batch) return null;

    const winners = members.filter((m) => m.batchRank != null);
    const inProgress = members.filter((m) => m.status === "RESEARCHING" || m.status === "EVALUATING");
    const notSelected = members.filter((m) => m.status === "COMPLETED" && m.batchRank == null);
    const failed = members.filter((m) => m.status === "FAILED");

    const doneCount = members.filter((m) => m.status === "COMPLETED" || m.status === "FAILED").length;
    const isWorking = batch.status === "RUNNING" || batch.status === "DISPATCHING";

    const statusBadge =
        batch.status === "COMPLETED" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" :
        batch.status === "FAILED" ? "border-rose-400/30 bg-rose-400/10 text-rose-300" :
        "border-sky-400/30 bg-sky-400/10 text-sky-300";

    return (
        <div className="flex-1 bg-surface-primary py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-5xl mx-auto space-y-8">
                {/* Header */}
                <div className="rounded-[2rem] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.18),transparent_38%),linear-gradient(180deg,rgba(18,18,28,0.96),rgba(14,14,20,0.98))] shadow-[0_28px_80px_rgba(0,0,0,0.45)] p-6 sm:p-8">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5">
                        <div className="space-y-3">
                            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white">
                                Hiring Committee — <span className="gradient-text">{batch.jobTitle}</span>
                            </h1>
                            <p className="text-sm text-content-secondary max-w-2xl leading-relaxed">
                                Vetting the top candidates above {batch.matchThreshold}% match and ranking the best {batch.targetHireCount} by AI fit score.
                            </p>
                            <div className="flex flex-wrap gap-2 text-xs text-content-tertiary">
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Target hires: {batch.targetHireCount}</span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Pool: {batch.poolSize}</span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Dispatched: {batch.dispatchedCount}</span>
                                {batch.skippedCount > 0 && <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Skipped: {batch.skippedCount}</span>}
                            </div>
                            {batch.recruiterInstructions && (
                                <div className="mt-2 p-3 rounded-xl border border-brand-500/20 bg-brand-500/5 text-xs text-content-secondary max-w-2xl">
                                    <span className="font-bold text-brand-300 uppercase tracking-wider text-[0.65rem]">Priority instructions</span>
                                    <p className="mt-1 leading-relaxed">{batch.recruiterInstructions}</p>
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col items-start sm:items-end gap-3">
                            <Link href="/vetting" className="inline-flex items-center gap-1.5 text-xs font-bold text-content-tertiary transition-colors hover:text-white">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                                All Sessions
                            </Link>
                            <div className={`px-4 py-2 rounded-2xl border text-xs font-black uppercase tracking-[0.18em] ${statusBadge}`}>
                                {batch.status === "DISPATCHING" ? "Dispatching" : batch.status === "RUNNING" ? "Running" : batch.status === "COMPLETED" ? "Completed" : "Failed"}
                            </div>
                            {isWorking && members.length > 0 && (
                                <span className="text-xs text-content-tertiary">{doneCount} / {members.length} done</span>
                            )}
                        </div>
                    </div>
                </div>

                {batch.status === "FAILED" && batch.errorMessage && (
                    <div className="p-5 bg-rose-500/5 border border-rose-500/30 rounded-3xl text-sm text-content-secondary">
                        {batch.errorMessage}
                    </div>
                )}

                {/* Top Picks — only once finalized */}
                {batch.status === "COMPLETED" && (
                    <div className="space-y-4">
                        <h2 className="text-lg font-bold text-content-primary flex items-center gap-2">
                            <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"></path></svg>
                            Top Picks
                        </h2>
                        {winners.length === 0 ? (
                            <div className="bg-surface-card border border-border-default rounded-3xl p-8 text-center text-sm text-content-tertiary shadow-md">
                                No candidate completed with a scoreable result. Check the failed section below.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {winners.map((m) => (
                                    <Link
                                        key={m.sessionId}
                                        href={`/vetting/${m.sessionId}`}
                                        className="flex items-center justify-between gap-4 p-5 bg-surface-card border border-emerald-500/20 rounded-2xl hover:border-emerald-500/50 transition-all shadow-md no-underline"
                                    >
                                        <div className="flex items-center gap-4 min-w-0">
                                            <div className="w-10 h-10 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm font-black shrink-0">
                                                #{m.batchRank}
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="font-bold text-content-primary truncate">{m.candidateName}</h3>
                                                <p className="text-xs text-content-tertiary truncate">{m.candidateEmail}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                            {m.verdict && (
                                                <span className="hidden sm:inline px-2.5 py-1 rounded-full text-[0.65rem] font-bold border border-border-default bg-surface-secondary text-content-tertiary uppercase">{m.verdict}</span>
                                            )}
                                            <span className="text-lg font-black text-emerald-500">{m.overallFitPercentage}%</span>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* In progress */}
                {inProgress.length > 0 && (
                    <div className="space-y-3">
                        <h2 className="text-sm font-bold text-content-tertiary uppercase tracking-widest">In progress ({inProgress.length})</h2>
                        <div className="space-y-2">
                            {inProgress.map((m) => (
                                <Link key={m.sessionId} href={`/vetting/${m.sessionId}`} className="flex items-center justify-between gap-4 p-4 bg-surface-card border border-border-default rounded-2xl hover:border-brand-500/40 transition-all no-underline">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin shrink-0" />
                                        <span className="font-semibold text-content-primary truncate">{m.candidateName}</span>
                                    </div>
                                    <span className="text-xs font-bold text-brand-500 shrink-0">{m.status === "EVALUATING" ? "Evaluating" : "Researching"}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* Completed, not selected */}
                {notSelected.length > 0 && (
                    <div className="space-y-3">
                        <h2 className="text-sm font-bold text-content-tertiary uppercase tracking-widest">Completed, not selected ({notSelected.length})</h2>
                        <div className="space-y-2">
                            {notSelected.sort((a, b) => (b.overallFitPercentage ?? 0) - (a.overallFitPercentage ?? 0)).map((m) => (
                                <Link key={m.sessionId} href={`/vetting/${m.sessionId}`} className="flex items-center justify-between gap-4 p-4 bg-surface-card border border-border-default rounded-2xl hover:border-brand-500/40 transition-all no-underline">
                                    <div className="min-w-0">
                                        <span className="font-semibold text-content-primary truncate">{m.candidateName}</span>
                                    </div>
                                    <span className="text-sm font-bold text-content-secondary shrink-0">{m.overallFitPercentage != null ? `${m.overallFitPercentage}%` : "—"}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* Failed / excluded */}
                {failed.length > 0 && (
                    <div className="space-y-3">
                        <h2 className="text-sm font-bold text-content-tertiary uppercase tracking-widest">Failed — excluded from ranking ({failed.length})</h2>
                        <div className="space-y-2">
                            {failed.map((m) => (
                                <Link key={m.sessionId} href={`/vetting/${m.sessionId}`} className="flex items-center justify-between gap-4 p-4 bg-rose-500/5 border border-rose-500/20 rounded-2xl hover:border-rose-500/40 transition-all no-underline">
                                    <span className="font-semibold text-content-primary truncate">{m.candidateName}</span>
                                    <span className="text-xs font-bold text-rose-500 shrink-0">Failed</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
