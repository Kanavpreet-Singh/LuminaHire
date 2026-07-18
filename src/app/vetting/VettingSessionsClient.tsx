"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface VettingSessionListItem {
    id: string;
    status: string;
    updatedAt: string;
    finalReport: unknown;
    candidateName: string;
    jobId: string;
    jobTitle: string;
}

interface BatchMember extends VettingSessionListItem {
    candidateEmail: string;
    batchRank: number | null;
}

interface VettingBatchListItem {
    id: string;
    jobId: string;
    jobTitle: string;
    status: string;
    targetHireCount: number;
    matchThreshold: number;
    poolSize: number;
    dispatchedCount: number;
    skippedCount: number;
    createdAt: string;
    updatedAt: string;
    finalizedAt: string | null;
    errorMessage: string | null;
    members: BatchMember[];
}

interface JobFilterOption {
    id: string;
    title: string;
}

interface VettingSessionsClientProps {
    initialSessions: VettingSessionListItem[];
    initialBatches: VettingBatchListItem[];
    jobs: JobFilterOption[];
    initialJobId: string;
}

const RUNNING_SESSION_STATUSES = new Set(["RESEARCHING", "EVALUATING"]);
const RUNNING_BATCH_STATUSES = new Set(["DISPATCHING", "RUNNING"]);

function getFinalFitScore(finalReport: unknown): number | null {
    const value = (finalReport as { overall_fit_percentage?: unknown } | null)?.overall_fit_percentage;
    return typeof value === "number" ? value : null;
}

function formatDate(dateInput: string): string {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString();
}

function getStatusBadgeClass(status: string): string {
    if (status === "COMPLETED") return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    if (status === "RESEARCHING" || status === "EVALUATING" || status === "RUNNING" || status === "DISPATCHING") {
        return "bg-blue-500/10 text-blue-600 border-blue-500/20 animate-pulse";
    }
    if (status === "FAILED") return "bg-rose-500/10 text-rose-600 border-rose-500/20";
    return "bg-amber-500/10 text-amber-600 border-amber-500/20";
}

function getSessionCta(status: string): string {
    if (status === "COMPLETED") return "View Report";
    if (status === "PLANNING") return "Edit Plan (HITL)";
    return "View Status";
}

function sortBatchMembers(members: BatchMember[]): BatchMember[] {
    return [...members].sort((a, b) => {
        if (a.batchRank != null && b.batchRank != null) return a.batchRank - b.batchRank;
        if (a.batchRank != null) return -1;
        if (b.batchRank != null) return 1;
        return (getFinalFitScore(b.finalReport) ?? -1) - (getFinalFitScore(a.finalReport) ?? -1);
    });
}

export default function VettingSessionsClient({
    initialSessions,
    initialBatches,
    jobs,
    initialJobId,
}: VettingSessionsClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const [sessions, setSessions] = useState(initialSessions);
    const [batches, setBatches] = useState(initialBatches);
    const [selectedJobId, setSelectedJobId] = useState(initialJobId);
    const [expandedBatchId, setExpandedBatchId] = useState(initialBatches[0]?.id || "");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const hasRunningWork = useMemo(
        () =>
            sessions.some((session) => RUNNING_SESSION_STATUSES.has(session.status)) ||
            batches.some((batch) =>
                RUNNING_BATCH_STATUSES.has(batch.status) ||
                batch.members.some((member) => RUNNING_SESSION_STATUSES.has(member.status))
            ),
        [batches, sessions]
    );

    const loadSessions = useCallback(async (jobId = selectedJobId, showLoading = false) => {
        if (showLoading) setLoading(true);
        try {
            const params = new URLSearchParams();
            if (jobId) params.set("jobId", jobId);
            const res = await fetch(`/api/vet/sessions${params.size ? `?${params.toString()}` : ""}`, {
                cache: "no-store",
            });
            if (!res.ok) {
                setError((await res.text()) || "Failed to load sessions.");
                return;
            }
            const data = await res.json();
            setSessions(data.sessions || []);
            setBatches(data.batches || []);
            setError("");
        } catch {
            setError("Could not reach the server.");
        } finally {
            if (showLoading) setLoading(false);
        }
    }, [selectedJobId]);

    useEffect(() => {
        const jobId = searchParams.get("jobId") || "";
        setSelectedJobId(jobId);
        loadSessions(jobId, true);
    }, [loadSessions, searchParams]);

    useEffect(() => {
        const intervalMs = hasRunningWork ? 2500 : 10000;
        const interval = setInterval(() => {
            if (document.visibilityState === "visible") {
                loadSessions(selectedJobId);
            }
        }, intervalMs);
        return () => clearInterval(interval);
    }, [hasRunningWork, loadSessions, selectedJobId]);

    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                loadSessions(selectedJobId);
            }
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }, [loadSessions, selectedJobId]);

    const handleJobChange = (jobId: string) => {
        setSelectedJobId(jobId);
        const params = new URLSearchParams(searchParams.toString());
        if (jobId) {
            params.set("jobId", jobId);
        } else {
            params.delete("jobId");
        }
        router.replace(params.size ? `/vetting?${params.toString()}` : "/vetting", { scroll: false });
    };

    const toggleBatch = (batchId: string) => {
        setExpandedBatchId((current) => (current === batchId ? "" : batchId));
    };

    return (
        <div className="space-y-8">
            <div className="bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h2 className="text-lg font-bold text-content-primary">Session History</h2>
                        <p className="text-xs text-content-tertiary mt-1">
                            {hasRunningWork ? "Refreshing live while agents finish." : "Refreshing periodically for new results."}
                        </p>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        {loading && <span className="text-xs font-semibold text-content-tertiary">Updating...</span>}
                        <label className="flex flex-col gap-1 text-xs font-bold uppercase tracking-wider text-content-tertiary">
                            Job Posting
                            <select
                                value={selectedJobId}
                                onChange={(event) => handleJobChange(event.target.value)}
                                className="min-w-56 rounded-xl border border-border-default bg-surface-primary px-3 py-2 text-sm font-semibold normal-case tracking-normal text-content-secondary outline-none transition-colors hover:border-brand-500/50 focus:border-brand-500"
                            >
                                <option value="">All job postings</option>
                                {jobs.map((job) => (
                                    <option key={job.id} value={job.id}>
                                        {job.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>

                {error && (
                    <div className="mt-5 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-500">
                        {error}
                    </div>
                )}
            </div>

            <section className="bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                <div className="flex items-center justify-between gap-4 mb-5">
                    <div>
                        <h2 className="text-xl font-black text-content-primary">Batch Runs</h2>
                        <p className="text-xs text-content-tertiary mt-1">Grouped hiring committee runs with every evaluated candidate.</p>
                    </div>
                    <span className="rounded-full border border-border-default bg-surface-primary px-3 py-1 text-xs font-bold text-content-tertiary">
                        {batches.length}
                    </span>
                </div>

                {batches.length === 0 ? (
                    <EmptyState message="No batch runs found for this filter." />
                ) : (
                    <div className="space-y-4">
                        {batches.map((batch) => {
                            const isExpanded = expandedBatchId === batch.id;
                            const doneCount = batch.members.filter((member) => member.status === "COMPLETED" || member.status === "FAILED").length;
                            const winners = batch.members.filter((member) => member.batchRank != null).length;
                            return (
                                <div key={batch.id} className="overflow-hidden rounded-2xl border border-border-default bg-surface-primary">
                                    <button
                                        type="button"
                                        onClick={() => toggleBatch(batch.id)}
                                        className="w-full p-5 text-left transition-colors hover:bg-surface-secondary/50"
                                    >
                                        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h3 className="font-black text-content-primary truncate text-lg">{batch.jobTitle}</h3>
                                                    <span className={`shrink-0 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded-full border ${getStatusBadgeClass(batch.status)}`}>
                                                        {batch.status}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-content-tertiary mt-1">
                                                    Started {formatDate(batch.createdAt)} &bull; {doneCount}/{batch.members.length} candidates done
                                                </p>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                                <Metric label="Target" value={batch.targetHireCount.toString()} />
                                                <Metric label="Pool" value={batch.poolSize.toString()} />
                                                <Metric label="Dispatched" value={batch.dispatchedCount.toString()} />
                                                <Metric label="Winners" value={winners.toString()} />
                                            </div>
                                        </div>
                                    </button>

                                    {isExpanded && (
                                        <div className="border-t border-border-default p-4 sm:p-5">
                                            {batch.errorMessage && (
                                                <div className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-500">
                                                    {batch.errorMessage}
                                                </div>
                                            )}
                                            {batch.members.length === 0 ? (
                                                <p className="text-sm text-content-tertiary">No candidate sessions are attached to this batch.</p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {sortBatchMembers(batch.members).map((member) => {
                                                        const finalFitScore = getFinalFitScore(member.finalReport);
                                                        return (
                                                            <Link
                                                                key={member.id}
                                                                href={`/vetting/${member.id}`}
                                                                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-border-default bg-surface-card px-4 py-3 no-underline transition-colors hover:border-brand-500/40"
                                                            >
                                                                <div className="min-w-0">
                                                                    <div className="flex items-center gap-2">
                                                                        {member.batchRank != null && (
                                                                            <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[0.65rem] font-black text-white">
                                                                                #{member.batchRank}
                                                                            </span>
                                                                        )}
                                                                        <span className="font-bold text-content-primary truncate">{member.candidateName}</span>
                                                                    </div>
                                                                    <p className="text-xs text-content-tertiary truncate">{member.candidateEmail}</p>
                                                                </div>
                                                                <div className="flex items-center gap-3 shrink-0">
                                                                    {finalFitScore !== null && (
                                                                        <span className="text-sm font-black text-emerald-500">{finalFitScore}%</span>
                                                                    )}
                                                                    <span className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded-full border ${getStatusBadgeClass(member.status)}`}>
                                                                        {member.status}
                                                                    </span>
                                                                </div>
                                                            </Link>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            <div className="mt-4 flex justify-end">
                                                <Link href={`/vetting/batch/${batch.id}`} className="rounded-xl border border-border-default bg-surface-tertiary px-4 py-2 text-xs font-bold text-content-secondary no-underline transition-colors hover:bg-surface-secondary">
                                                    Open Batch Details
                                                </Link>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <section className="bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                <div className="flex items-center justify-between gap-4 mb-5">
                    <div>
                        <h2 className="text-xl font-black text-content-primary">Normal Sessions</h2>
                        <p className="text-xs text-content-tertiary mt-1">Single candidate HITL recruit sessions.</p>
                    </div>
                    <span className="rounded-full border border-border-default bg-surface-primary px-3 py-1 text-xs font-bold text-content-tertiary">
                        {sessions.length}
                    </span>
                </div>

                {sessions.length === 0 ? (
                    <EmptyState message="No normal sessions found for this filter." />
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {sessions.map((vs, idx) => (
                            <SessionCard key={vs.id} session={vs} index={idx} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

function EmptyState({ message }: { message: string }) {
    return (
        <div className="text-center py-12 border-2 border-dashed border-border-default rounded-3xl">
            <svg className="w-10 h-10 mx-auto text-content-tertiary mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
            <p className="text-content-secondary font-semibold">{message}</p>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-xl border border-border-default bg-surface-card px-3 py-2">
            <p className="text-[0.65rem] font-bold uppercase tracking-wider text-content-tertiary">{label}</p>
            <p className="text-sm font-black text-content-primary">{value}</p>
        </div>
    );
}

function SessionCard({ session, index }: { session: VettingSessionListItem; index: number }) {
    const finalFitScore = getFinalFitScore(session.finalReport);

    return (
        <div
            className="group p-6 bg-surface-primary border border-border-default rounded-2xl flex flex-col gap-4 hover:border-brand-500/50 hover:shadow-xl transition-all duration-300 animate-fadeInUp"
            style={{ animationDelay: `${Math.min(index * 0.05, 0.3)}s` }}
        >
            <div className="flex justify-between items-start">
                <div className="min-w-0">
                    <h3 className="font-bold text-content-primary truncate text-lg">{session.candidateName}</h3>
                    <p className="text-xs font-semibold text-content-tertiary truncate">for {session.jobTitle}</p>
                </div>
                <span className={`shrink-0 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded-full border ${getStatusBadgeClass(session.status)}`}>
                    {session.status}
                </span>
            </div>

            <div className="flex flex-col gap-1 flex-1">
                <span className="text-xs text-content-secondary flex items-center gap-2">
                    <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    Updated {formatDate(session.updatedAt)}
                </span>
                {session.status === "COMPLETED" && finalFitScore !== null && (
                    <span className="text-xs font-bold text-emerald-500 mt-2">
                        Final Fit Score: {finalFitScore}%
                    </span>
                )}
            </div>

            <Link
                href={`/vetting/${session.id}`}
                className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all text-center no-underline flex items-center justify-center gap-2 ${
                    session.status === "COMPLETED"
                        ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-md"
                        : session.status === "PLANNING"
                            ? "bg-[image:var(--gradient-primary)] hover:opacity-95 text-white shadow-md hover:-translate-y-0.5"
                            : "bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default"
                }`}
            >
                {getSessionCta(session.status)}
            </Link>
        </div>
    );
}
