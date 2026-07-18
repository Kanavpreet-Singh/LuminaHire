"use client";

import { useState } from "react";
import Link from "next/link";

interface JobPosting {
    id: string;
    title: string;
    description: string;
    requirements: string | null;
    status: string;
    createdAt: Date;
}

function formatDate(dateInput: string | Date): string {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

interface CandidateMatch {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    skills: string[];
    resumeUrl: string | null;
    resumeText: string | null;
    matchScore: number | null;
    applicationId: string | null;
    sessionId: string | null;
    sessionStatus: string | null;
}

interface RecruiterDashboardProps {
    initialUser: {
        name: string | null;
        email: string;
        companyName: string | null;
    };
    initialJobs: JobPosting[];
}

export default function RecruiterDashboard({ initialUser, initialJobs }: RecruiterDashboardProps) {
    const [jobs, setJobs] = useState<JobPosting[]>(initialJobs);
    const [selectedJob, setSelectedJob] = useState<JobPosting | null>(null);
    const [matches, setMatches] = useState<CandidateMatch[]>([]);
    const [loadingMatches, setLoadingMatches] = useState(false);
    const [matchError, setMatchError] = useState("");
    
    // View/Edit & Delete states
    const [editingJob, setEditingJob] = useState<JobPosting | null>(null);
    const [deletingJob, setDeletingJob] = useState<JobPosting | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editDesc, setEditDesc] = useState("");
    const [editReq, setEditReq] = useState("");
    const [editStatus, setEditStatus] = useState("OPEN");
    const [savingEdit, setSavingEdit] = useState(false);
    const [editError, setEditError] = useState("");
    const [deletingJobLoading, setDeletingJobLoading] = useState(false);
    const [deleteError, setDeleteError] = useState("");

    // Filters & Search
    const [minScore, setMinScore] = useState<number>(20);
    const [candidateSearch, setCandidateSearch] = useState("");
    const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
    const [initiatingVetId, setInitiatingVetId] = useState<string | null>(null);

    // Batch "Hiring Committee" trigger state
    const [batchOpen, setBatchOpen] = useState(false);
    const [batchN, setBatchN] = useState<number>(3);
    const [batchThreshold, setBatchThreshold] = useState<number>(50);
    const [batchInstructions, setBatchInstructions] = useState("");
    const [launchingBatch, setLaunchingBatch] = useState(false);
    const [batchError, setBatchError] = useState("");
    const [existingBatchId, setExistingBatchId] = useState<string | null>(null);

    const handleLaunchBatch = async () => {
        if (!selectedJob) return;
        setLaunchingBatch(true);
        setBatchError("");
        setExistingBatchId(null);
        try {
            const res = await fetch("/api/vet/batch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jobId: selectedJob.id,
                    targetHireCount: batchN,
                    matchThreshold: batchThreshold,
                    recruiterInstructions: batchInstructions.trim() || undefined,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 409) {
                setExistingBatchId(data.existingBatchId || null);
                setBatchError("A batch is already running for this job.");
                return;
            }
            if (!res.ok) {
                throw new Error(data.error || "Failed to launch batch");
            }
            window.location.href = `/vetting/batch/${data.batchId}`;
        } catch (err: any) {
            setBatchError(err.message || "Something went wrong launching the batch.");
        } finally {
            setLaunchingBatch(false);
        }
    };

    const handleInitiateVetting = async (candidateId: string, jobId: string) => {
        setInitiatingVetId(candidateId);
        try {
            const res = await fetch("/api/vet/initiate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ candidateId, jobId })
            });
            if (!res.ok) {
                throw new Error(await res.text() || "Failed to initiate vetting");
            }
            const data = await res.json();
            // Redirect to vetting session page
            window.location.href = `/vetting/${data.vettingSession.id}`;
        } catch (err: any) {
            alert(err.message || "Something went wrong initiating the vetting session.");
        } finally {
            setInitiatingVetId(null);
        }
    };

    const startEditing = (job: JobPosting) => {
        setEditingJob(job);
        setEditTitle(job.title);
        setEditDesc(job.description);
        setEditReq(job.requirements || "");
        setEditStatus(job.status);
        setEditError("");
        setSavingEdit(false);
    };

    const startDeleting = (job: JobPosting) => {
        setDeletingJob(job);
        setDeleteError("");
        setDeletingJobLoading(false);
    };

    const handleSaveEdit = async () => {
        if (!editingJob) return;
        if (!editTitle.trim() || !editDesc.trim()) {
            setEditError("Title and description are required.");
            return;
        }

        setSavingEdit(true);
        setEditError("");

        try {
            const res = await fetch(`/api/jobs/${editingJob.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: editTitle,
                    description: editDesc,
                    requirements: editReq || null,
                    status: editStatus,
                }),
            });

            if (!res.ok) {
                const errMsg = await res.text();
                throw new Error(errMsg || "Failed to update job posting");
            }

            const data = await res.json();
            setJobs(prevJobs => prevJobs.map(j => j.id === editingJob.id ? data.job : j));
            if (selectedJob && selectedJob.id === editingJob.id) {
                setSelectedJob(data.job);
            }
            setEditingJob(null);
        } catch (err: any) {
            setEditError(err.message || "Failed to save changes. Please try again.");
        } finally {
            setSavingEdit(false);
        }
    };

    const handleConfirmDelete = async () => {
        if (!deletingJob) return;

        setDeletingJobLoading(true);
        setDeleteError("");

        try {
            const res = await fetch(`/api/jobs/${deletingJob.id}`, {
                method: "DELETE",
            });

            if (!res.ok) {
                const errMsg = await res.text();
                throw new Error(errMsg || "Failed to delete job posting");
            }

            setJobs(prevJobs => prevJobs.filter(j => j.id !== deletingJob.id));
            if (selectedJob && selectedJob.id === deletingJob.id) {
                setSelectedJob(null);
            }
            setDeletingJob(null);
        } catch (err: any) {
            setDeleteError(err.message || "Failed to delete job posting. Please try again.");
        } finally {
            setDeletingJobLoading(false);
        }
    };

    const fetchMatches = async (job: JobPosting) => {
        setSelectedJob(job);
        setLoadingMatches(true);
        setMatchError("");
        setMatches([]);
        setExpandedCandidateId(null);
        
        try {
            const res = await fetch(`/api/jobs/matches?jobId=${job.id}`);
            if (!res.ok) {
                throw new Error("Failed to load candidate matches");
            }
            const data = await res.json();
            setMatches(data.matches || []);
        } catch (err: any) {
            setMatchError(err.message || "An error occurred while fetching matches");
        } finally {
            setLoadingMatches(false);
        }
    };

    const getScoreColor = (score: number) => {
        if (score >= 80) return "text-emerald-500 bg-emerald-500/10 border-emerald-500/25";
        if (score >= 60) return "text-blue-500 bg-blue-500/10 border-blue-500/25";
        if (score >= 40) return "text-amber-500 bg-amber-500/10 border-amber-500/25";
        return "text-rose-500 bg-rose-500/10 border-rose-500/25";
    };

    const getScoreProgressColor = (score: number) => {
        if (score >= 80) return "bg-emerald-500";
        if (score >= 60) return "bg-blue-500";
        if (score >= 40) return "bg-amber-500";
        return "bg-rose-500";
    };

    // Filter and search matches
    const filteredMatches = matches.filter(match => {
        const score = match.matchScore ?? 0;
        if (score <= 0) return false; // Exclude completely unrelated candidates (0% match)
        if (score < minScore) return false;
        
        if (candidateSearch.trim()) {
            const query = candidateSearch.toLowerCase();
            const nameMatch = match.name.toLowerCase().includes(query);
            const emailMatch = match.email.toLowerCase().includes(query);
            const skillMatch = match.skills.some(skill => skill.toLowerCase().includes(query));
            return nameMatch || emailMatch || skillMatch;
        }
        
        return true;
    });

    // Candidates that would enter a batch at the current threshold (mirrors the
    // Python-side pre-filter: matchScore > batchThreshold).
    const batchPoolCount = matches.filter((m) => (m.matchScore ?? 0) > batchThreshold).length;

    return (
        <div className="space-y-10 relative z-10">
            {/* Header & Personal Details */}
            <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6 w-full min-w-0">
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[image:var(--gradient-primary)] flex items-center justify-center text-2xl sm:text-3xl font-bold text-white shadow-lg shrink-0">
                        {initialUser.name?.charAt(0).toUpperCase() || "R"}
                    </div>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-2xl sm:text-3xl font-extrabold text-content-primary tracking-tight mb-1 break-words">
                            Welcome back, {initialUser.name}
                        </h1>
                        <div className="text-content-secondary font-medium text-sm sm:text-base flex flex-col sm:flex-row sm:items-center sm:gap-2 break-all sm:break-normal">
                            <span>{initialUser.email}</span>
                            <span className="hidden sm:inline">&bull;</span>
                            <span>Recruiter at <span className="text-brand-500 font-semibold">{initialUser.companyName || "Unknown Company"}</span></span>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-3 w-full lg:w-auto shrink-0">
                    <Link href="/vetting" className="flex-1 lg:flex-none text-center px-5 sm:px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl font-bold transition-all shadow-sm text-sm sm:text-base whitespace-nowrap">
                        Vetting History
                    </Link>
                    <Link href="/profile" className="flex-1 lg:flex-none text-center px-5 sm:px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl font-bold transition-all shadow-sm text-sm sm:text-base whitespace-nowrap">
                        Edit Profile
                    </Link>
                    <Link href="/dashboard/jobs/new" className="flex-1 lg:flex-none text-center px-5 sm:px-6 py-3 bg-[image:var(--gradient-primary)] hover:opacity-95 text-white rounded-xl font-bold transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5 text-sm sm:text-base whitespace-nowrap">
                        + Post a Job
                    </Link>
                </div>
            </div>

            {/* Dashboard Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-surface-card backdrop-blur-xl p-8 rounded-3xl border border-border-default shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-content-primary">Your Company</h2>
                        <div className="w-10 h-10 rounded-full bg-brand-500/10 flex items-center justify-center text-brand-500">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
                        </div>
                    </div>
                    <p className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 mb-2 truncate">
                        {initialUser.companyName || "Setup Required"}
                    </p>
                    <p className="text-content-tertiary text-sm">You are hiring for this organization</p>
                </div>
                
                <div className="bg-surface-card backdrop-blur-xl p-8 rounded-3xl border border-border-default shadow-lg">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-content-primary">Total Job Postings</h2>
                        <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                        </div>
                    </div>
                    <p className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 mb-2">
                        {jobs.length}
                    </p>
                    <p className="text-content-tertiary text-sm">Active roles tracking candidates</p>
                </div>
            </div>

            {/* Job Postings List */}
            <div className="bg-surface-card backdrop-blur-xl p-8 rounded-3xl border border-border-default shadow-lg">
                <h2 className="text-2xl font-bold text-content-primary mb-6">Recent Job Postings</h2>
                
                {jobs.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed border-border-default rounded-2xl">
                        <p className="text-content-secondary mb-4">You haven't posted any jobs yet.</p>
                        <Link href="/dashboard/jobs/new" className="inline-flex px-6 py-3 bg-[image:var(--gradient-primary)] text-white font-bold rounded-xl transition-all shadow-md hover:scale-105">
                            Create Your First Job
                        </Link>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {jobs.map((job, idx) => (
                            <div
                                key={job.id}
                                className="group flex flex-col lg:flex-row lg:items-center justify-between p-6 bg-surface-primary border border-border-default rounded-2xl hover:border-brand-500 transition-all duration-200 animate-fadeInUp"
                                style={{ animationDelay: `${Math.min(idx * 0.05, 0.3)}s` }}
                            >
                                <div className="space-y-1">
                                    <h3 className="text-xl font-bold text-content-primary group-hover:text-brand-500 transition-colors">
                                        {job.title}
                                    </h3>
                                    <p className="text-content-tertiary text-sm">
                                        Posted on {formatDate(job.createdAt)}
                                        &nbsp;&bull;&nbsp; 
                                        <span className="text-brand-500 font-semibold">
                                            {initialUser.companyName}
                                        </span>
                                    </p>
                                </div>
                                <div className="mt-4 lg:mt-0 flex flex-wrap items-center gap-3">
                                    <span className="px-3 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 text-xs font-bold rounded-full uppercase tracking-wider">
                                        {job.status}
                                    </span>
                                    <button 
                                        onClick={() => fetchMatches(job)}
                                        className="px-4 py-2.5 bg-brand-500 text-white hover:bg-brand-600 rounded-xl text-sm font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                                        AI Matches
                                    </button>
                                    <button 
                                        onClick={() => startEditing(job)}
                                        className="px-4 py-2.5 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl text-sm font-bold transition-all flex items-center gap-1.5 cursor-pointer"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                                        Edit
                                    </button>
                                    <button 
                                        onClick={() => startDeleting(job)}
                                        className="px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500 hover:text-white border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-sm font-bold transition-all flex items-center gap-1.5 cursor-pointer"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* AI Candidate Matches Popup / Modal */}
            {selectedJob && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    {/* Modal Content */}
                    <div className="w-full max-w-3xl bg-surface-primary rounded-3xl border border-border-default flex flex-col shadow-2xl max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="p-6 sm:p-8 border-b border-border-default flex items-center justify-between bg-surface-card shrink-0">
                            <div>
                                <span className="text-xs font-bold text-brand-500 uppercase tracking-widest">Semantic AI Match scoring</span>
                                <h2 className="text-xl sm:text-2xl font-extrabold text-content-primary mt-1 line-clamp-1">{selectedJob.title}</h2>
                                <p className="text-content-secondary text-sm">Review ranked candidates based on vector similarity</p>
                            </div>
                            <button 
                                onClick={() => setSelectedJob(null)}
                                className="p-2 text-content-tertiary hover:text-content-primary hover:bg-surface-tertiary rounded-full transition-all cursor-pointer"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                        </div>

                        {/* Search & Filters */}
                        <div className="p-6 border-b border-border-default bg-surface-card/40 flex flex-col sm:flex-row gap-4 items-center shrink-0">
                            {/* Search bar */}
                            <div className="relative w-full sm:flex-1">
                                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-content-tertiary">
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                                </div>
                                <input
                                    type="text"
                                    value={candidateSearch}
                                    onChange={(e) => setCandidateSearch(e.target.value)}
                                    placeholder="Search by name, email, or skills..."
                                    className="w-full pl-9 pr-4 py-2 text-sm bg-surface-primary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary placeholder:text-content-tertiary"
                                />
                            </div>

                            {/* Cosine similarity filter */}
                            <div className="flex items-center gap-3 w-full sm:w-auto">
                                <span className="text-xs font-semibold text-content-secondary whitespace-nowrap">Min Score: {minScore}%</span>
                                <input 
                                    type="range"
                                    min="0"
                                    max="95"
                                    step="5"
                                    value={minScore}
                                    onChange={(e) => setMinScore(Number(e.target.value))}
                                    className="w-full sm:w-32 accent-brand-500 cursor-pointer"
                                />
                            </div>
                        </div>

                        {/* Batch "Hiring Committee" trigger */}
                        <div className="px-6 pt-5 pb-1 border-b border-border-default bg-surface-card/40 shrink-0">
                            <button
                                onClick={() => setBatchOpen((o) => !o)}
                                className="w-full flex items-center justify-between gap-3 text-left group cursor-pointer"
                            >
                                <div className="flex items-center gap-2.5">
                                    <div className="w-8 h-8 rounded-lg bg-[image:var(--gradient-primary)] flex items-center justify-center text-white shrink-0">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-extrabold text-content-primary">Run Hiring Committee (Batch)</h3>
                                        <p className="text-[0.7rem] text-content-tertiary">Auto-vet the whole shortlist, rank the top-N by AI fit score.</p>
                                    </div>
                                </div>
                                <svg className={`w-5 h-5 text-content-tertiary transition-transform ${batchOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                            </button>

                            {batchOpen && (
                                <div className="mt-4 pb-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-bold text-content-secondary">Target hires (N)</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={10}
                                                value={batchN}
                                                onChange={(e) => setBatchN(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                                                className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-bold text-content-secondary">Min similarity: {batchThreshold}%</label>
                                            <input
                                                type="range"
                                                min={0}
                                                max={95}
                                                step={5}
                                                value={batchThreshold}
                                                onChange={(e) => setBatchThreshold(Number(e.target.value))}
                                                className="w-full accent-brand-500 cursor-pointer mt-2"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-1.5">
                                        <label className="text-xs font-bold text-content-secondary">Priority instructions (optional)</label>
                                        <textarea
                                            value={batchInstructions}
                                            onChange={(e) => setBatchInstructions(e.target.value)}
                                            rows={2}
                                            placeholder="e.g. we focus a lot on LeetCode ratings and problems solved"
                                            className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary placeholder:text-content-tertiary resize-none"
                                        />
                                        <p className="text-[0.7rem] text-content-tertiary">Obeyed by the planner, researcher, and evaluator when scoring every candidate.</p>
                                    </div>

                                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                                        <p className="text-xs text-content-secondary">
                                            <span className="font-bold text-brand-500">{Math.min(batchPoolCount, 20)}</span> candidate{batchPoolCount === 1 ? "" : "s"} above {batchThreshold}% will be vetted
                                            {batchPoolCount > 20 && <span className="text-content-tertiary"> (capped at 20)</span>}.
                                        </p>
                                        <button
                                            onClick={handleLaunchBatch}
                                            disabled={launchingBatch || batchPoolCount === 0}
                                            className="px-5 py-2.5 bg-[image:var(--gradient-primary)] hover:opacity-95 text-white rounded-xl text-sm font-bold transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                                        >
                                            {launchingBatch && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                            {launchingBatch ? "Launching..." : "Launch Hiring Committee"}
                                        </button>
                                    </div>

                                    {batchError && (
                                        <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-semibold flex items-center justify-between gap-2">
                                            <span>{batchError}</span>
                                            {existingBatchId && (
                                                <Link href={`/vetting/batch/${existingBatchId}`} className="underline whitespace-nowrap">View running batch</Link>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Candidates List */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {loadingMatches ? (
                                <div className="flex flex-col justify-center items-center h-64 space-y-3">
                                    <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                                    <span className="text-content-secondary text-sm font-semibold">Running vector similarity calculations...</span>
                                </div>
                            ) : matchError ? (
                                <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-2xl text-center text-sm font-semibold">
                                    {matchError}
                                </div>
                            ) : filteredMatches.length === 0 ? (
                                <div className="text-center py-16 border-2 border-dashed border-border-default rounded-3xl">
                                    <svg className="w-12 h-12 mx-auto text-content-tertiary mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                                    <p className="text-content-secondary text-sm font-semibold">No candidates match the criteria.</p>
                                    <p className="text-content-tertiary text-xs mt-1">Make sure candidates have uploaded resumes to enable matching.</p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {filteredMatches.map((match, idx) => {
                                        const isExpanded = expandedCandidateId === match.id;
                                        const score = match.matchScore ?? 0;

                                        return (
                                            <div
                                                key={match.id}
                                                className={`border rounded-2xl transition-all duration-200 overflow-hidden animate-fadeInUp ${isExpanded ? "border-brand-500 bg-surface-card/45 shadow-lg" : "border-border-default bg-surface-card hover:border-brand-500/50"}`}
                                                style={{ animationDelay: `${Math.min(idx * 0.04, 0.24)}s` }}
                                            >
                                                {/* Summary card */}
                                                <div 
                                                    onClick={() => setExpandedCandidateId(isExpanded ? null : match.id)}
                                                    className="p-5 flex items-center justify-between gap-4 cursor-pointer"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <h4 className="font-bold text-content-primary truncate text-base">{match.name}</h4>
                                                            <span className={`px-2 py-0.5 rounded-full text-[0.7rem] font-bold border ${getScoreColor(score)}`}>
                                                                {score}% Match
                                                            </span>
                                                        </div>
                                                        <p className="text-xs text-content-tertiary truncate mt-1">{match.email} {match.phone ? `• ${match.phone}` : ""}</p>
                                                        
                                                        {match.skills.length > 0 && (
                                                            <div className="flex flex-wrap gap-1 mt-2.5">
                                                                {match.skills.slice(0, 4).map((skill, idx) => (
                                                                    <span key={idx} className="px-2 py-0.5 bg-surface-secondary border border-border-default rounded-md text-[0.7rem] font-semibold text-content-secondary">
                                                                        {skill}
                                                                    </span>
                                                                ))}
                                                                {match.skills.length > 4 && (
                                                                    <span className="text-[0.7rem] font-bold text-content-tertiary py-0.5 px-1">
                                                                        +{match.skills.length - 4} more
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Radial Score Indicator */}
                                                    <div className="relative w-14 h-14 flex items-center justify-center shrink-0">
                                                        <svg className="w-full h-full transform -rotate-90">
                                                            <circle 
                                                                cx="28" 
                                                                cy="28" 
                                                                r="22" 
                                                                stroke="currentColor" 
                                                                strokeWidth="4" 
                                                                className="text-border-default" 
                                                                fill="transparent" 
                                                            />
                                                            <circle 
                                                                cx="28" 
                                                                cy="28" 
                                                                r="22" 
                                                                stroke="currentColor" 
                                                                strokeWidth="4" 
                                                                strokeDasharray={2 * Math.PI * 22}
                                                                strokeDashoffset={2 * Math.PI * 22 * (1 - score / 100)}
                                                                className={getScoreColor(score).split(" ")[0]}
                                                                strokeLinecap="round"
                                                                fill="transparent" 
                                                            />
                                                        </svg>
                                                        <span className="absolute text-xs font-black text-content-primary">{score}%</span>
                                                    </div>
                                                </div>

                                                {/* Expanded Details */}
                                                {isExpanded && (
                                                    <div className="px-5 pb-5 pt-3 border-t border-border-default bg-surface-primary/30 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                                                        {/* Linear match bar */}
                                                        <div className="space-y-1.5">
                                                            <div className="flex justify-between text-xs font-semibold text-content-secondary">
                                                                <span>Semantic Compatibility</span>
                                                                <span>{score}% Match Score</span>
                                                            </div>
                                                            <div className="w-full h-2 bg-surface-secondary rounded-full overflow-hidden border border-border-default">
                                                                <div 
                                                                    className={`h-full rounded-full transition-all duration-500 ${getScoreProgressColor(score)}`}
                                                                    style={{ width: `${score}%` }}
                                                                />
                                                            </div>
                                                        </div>



                                                        {/* Resume buttons */}
                                                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
                                                            <span className="text-[0.7rem] text-content-tertiary">Calculated using Gemini embedding values</span>
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                {match.resumeUrl && (
                                                                    <a 
                                                                        href={match.resumeUrl}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="px-4 py-2 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 no-underline"
                                                                    >
                                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                                        Open Resume PDF
                                                                    </a>
                                                                )}
                                                                {match.sessionId ? (
                                                                    match.sessionStatus === "PLANNING" ? (
                                                                        <Link 
                                                                            href={`/vetting/${match.sessionId}`}
                                                                            className="px-4 py-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 no-underline"
                                                                        >
                                                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                                                                            Edit Recruit Plan
                                                                        </Link>
                                                                    ) : match.sessionStatus === "RESEARCHING" ? (
                                                                        <div className="px-4 py-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5">
                                                                            <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                                                            Agent Recruiting...
                                                                        </div>
                                                                    ) : match.sessionStatus === "COMPLETED" ? (
                                                                        <Link 
                                                                            href={`/vetting/${match.sessionId}`}
                                                                            className="px-4 py-2 bg-emerald-500 text-white hover:bg-emerald-600 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 no-underline shadow-sm"
                                                                        >
                                                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                                                                            View Recruit Report
                                                                        </Link>
                                                                    ) : (
                                                                        <button 
                                                                            onClick={() => handleInitiateVetting(match.id, selectedJob.id)}
                                                                            disabled={initiatingVetId !== null}
                                                                            className="px-4 py-2 bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500 hover:text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                                                        >
                                                                            {initiatingVetId === match.id ? (
                                                                                <div className="w-3 h-3 border-2 border-rose-500 border-t-transparent rounded-full animate-spin shrink-0" />
                                                                            ) : (
                                                                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 3v5h5"></path></svg>
                                                                            )}
                                                                            Retry Recruit
                                                                        </button>
                                                                    )
                                                                ) : (
                                                                    <button 
                                                                        onClick={() => handleInitiateVetting(match.id, selectedJob.id)}
                                                                        disabled={initiatingVetId !== null}
                                                                        className="px-4 py-2 bg-[image:var(--gradient-primary)] hover:opacity-95 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md hover:-translate-y-0.5 cursor-pointer disabled:opacity-50"
                                                                    >
                                                                        {initiatingVetId === match.id ? (
                                                                            <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                                                        ) : (
                                                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                                                                        )}
                                                                        Agent Recruit
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-border-default bg-surface-card flex justify-end gap-3 shrink-0">
                            <button 
                                onClick={() => setSelectedJob(null)}
                                className="px-5 py-2.5 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer"
                            >
                                Close Panel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Job Modal */}
            {editingJob && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="w-full max-w-2xl bg-surface-primary rounded-3xl border border-border-default flex flex-col shadow-2xl max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="p-6 sm:p-8 border-b border-border-default flex items-center justify-between bg-surface-card shrink-0">
                            <div>
                                <span className="text-xs font-bold text-brand-500 uppercase tracking-widest">Update details</span>
                                <h2 className="text-xl sm:text-2xl font-extrabold text-content-primary mt-1">Edit Job Posting</h2>
                            </div>
                            <button 
                                onClick={() => setEditingJob(null)}
                                className="p-2 text-content-tertiary hover:text-content-primary hover:bg-surface-tertiary rounded-full transition-all cursor-pointer"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                        </div>

                        {/* Scrollable form body */}
                        <div className="flex-1 overflow-y-auto p-6 sm:p-8 space-y-6">
                            {editError && (
                                <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-2xl text-sm font-semibold">
                                    {editError}
                                </div>
                            )}

                            {/* Job Title */}
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-primary">Job Title</label>
                                <input 
                                    type="text"
                                    value={editTitle}
                                    onChange={(e) => setEditTitle(e.target.value)}
                                    placeholder="e.g. Senior Frontend Developer"
                                    className="w-full px-4 py-3 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary placeholder:text-content-tertiary font-medium animate-none"
                                />
                            </div>

                            {/* Status */}
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-primary">Posting Status</label>
                                <select
                                    value={editStatus}
                                    onChange={(e) => setEditStatus(e.target.value)}
                                    className="w-full px-4 py-3 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary font-medium"
                                >
                                    <option value="OPEN">Open (Accepting Candidates)</option>
                                    <option value="CLOSED">Closed (Hidden from Explorers)</option>
                                </select>
                            </div>

                            {/* Description */}
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-primary">Job Description</label>
                                <textarea 
                                    rows={6}
                                    value={editDesc}
                                    onChange={(e) => setEditDesc(e.target.value)}
                                    placeholder="Describe the responsibilities and role details..."
                                    className="w-full px-4 py-3 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary placeholder:text-content-tertiary font-medium resize-none"
                                />
                            </div>

                            {/* Requirements */}
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-primary">Job Requirements (Optional)</label>
                                <textarea 
                                    rows={4}
                                    value={editReq}
                                    onChange={(e) => setEditReq(e.target.value)}
                                    placeholder="Skills, qualifications, years of experience required..."
                                    className="w-full px-4 py-3 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary placeholder:text-content-tertiary font-medium resize-none"
                                />
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-border-default bg-surface-card flex flex-col-reverse sm:flex-row justify-end gap-3 shrink-0">
                            <button
                                onClick={() => setEditingJob(null)}
                                disabled={savingEdit}
                                className="px-5 py-2.5 bg-surface-tertiary hover:bg-surface-secondary active:not-disabled:scale-[0.98] text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                disabled={savingEdit}
                                className="px-6 py-2.5 bg-[image:var(--gradient-primary)] hover:opacity-95 active:not-disabled:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {savingEdit && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                {savingEdit ? "Updating Embeddings..." : "Save Changes"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deletingJob && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="w-full max-w-md bg-surface-primary rounded-3xl border border-border-default flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                        {/* Header */}
                        <div className="p-6 border-b border-border-default flex items-center justify-between bg-surface-card shrink-0">
                            <div className="flex items-center gap-3 text-rose-500">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                <h2 className="text-lg font-bold text-content-primary">Delete Job Posting?</h2>
                            </div>
                            <button 
                                onClick={() => setDeletingJob(null)}
                                className="p-2 text-content-tertiary hover:text-content-primary hover:bg-surface-tertiary rounded-full transition-all cursor-pointer"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-6 space-y-4">
                            {deleteError && (
                                <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 rounded-2xl text-sm font-semibold">
                                    {deleteError}
                                </div>
                            )}

                            <p className="text-sm text-content-secondary leading-relaxed">
                                Are you sure you want to permanently delete the job posting <strong className="text-content-primary">"{deletingJob.title}"</strong>?
                            </p>
                            <p className="text-xs text-content-tertiary">
                                This will remove all database records, embeddings, and any matched candidate scoring for this job role. This action cannot be undone.
                            </p>
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-border-default bg-surface-card flex flex-col-reverse sm:flex-row justify-end gap-3 shrink-0">
                            <button
                                onClick={() => setDeletingJob(null)}
                                disabled={deletingJobLoading}
                                className="px-5 py-2.5 bg-surface-tertiary hover:bg-surface-secondary active:not-disabled:scale-[0.98] text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmDelete}
                                disabled={deletingJobLoading}
                                className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 active:not-disabled:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {deletingJobLoading && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                Delete Posting
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
