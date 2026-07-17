"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface Job {
    id: string;
    title: string;
    description: string;
    requirements: string | null;
    status: string;
    createdAt: string;
    recruiterName: string;
    companyName: string;
    matchScore: number | null;
}

function formatDate(dateInput: string | Date): string {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export default function JobsPage() {
    const { data: session, status } = useSession();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedJob, setSelectedJob] = useState<Job | null>(null);
    const [hasResume, setHasResume] = useState<boolean | null>(null);

    // Fetch jobs
    const fetchJobs = async (query = "") => {
        setLoading(true);
        try {
            const res = await fetch(`/api/jobs?query=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                setJobs(data);
            }
        } catch (error) {
            console.error("Error fetching jobs:", error);
        } finally {
            setLoading(false);
        }
    };

    // Check if candidate has uploaded resume
    useEffect(() => {
        if (status === "authenticated" && (session?.user as any)?.role === "CANDIDATE") {
            fetch("/api/profile")
                .then(res => res.json())
                .then(data => {
                    setHasResume(!!data.candidate?.resumeUrl);
                })
                .catch(() => setHasResume(false));
        } else {
            setHasResume(null);
        }
    }, [status, session]);

    useEffect(() => {
        fetchJobs(searchQuery);
    }, [searchQuery]);

    const getScoreBadgeColor = (score: number) => {
        if (score >= 80) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20";
        if (score >= 50) return "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20";
        return "bg-rose-500/10 text-rose-600 dark:text-rose-300 border-rose-500/20";
    };
    return (
        <div className="flex-1 bg-surface-primary text-content-primary py-12 px-4 sm:px-6 lg:px-8 relative">
            {/* Background glow with contained overflow */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                <div className="absolute -top-[30%] right-[10%] w-[700px] h-[700px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.06)_0%,transparent_70%)] blur-[100px]" />
            </div>

            <div className="max-w-6xl mx-auto space-y-10 relative z-10">
                {/* Header */}
                <div className="text-center space-y-4">
                    <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400">
                        Explore Opportunities
                    </h1>
                    <p className="max-w-2xl mx-auto text-content-secondary text-lg sm:text-xl font-medium">
                        Discover open roles mapped to your unique skills. Review semantic AI match scores instantly.
                    </p>
                </div>

                {/* Resume Warning Callout */}
                {status === "authenticated" && (session?.user as any)?.role === "CANDIDATE" && hasResume === false && (
                    <div className="p-6 bg-amber-500/10 border border-amber-500/20 rounded-3xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                        <div className="flex gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <div>
                                <h4 className="font-bold text-content-primary">Activate Semantic AI Match Scoring</h4>
                                <p className="text-content-secondary text-sm mt-0.5">Upload your PDF resume on the profile page to automatically generate similarity rankings for every job.</p>
                            </div>
                        </div>
                        <Link href="/profile" className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl text-sm shrink-0 transition-all shadow-sm">
                            Upload Resume
                        </Link>
                    </div>
                )}

                {/* Search Bar */}
                <div className="relative max-w-2xl mx-auto">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-content-tertiary">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by title, description, or company..."
                        className="w-full pl-12 pr-4 py-4 bg-surface-card border border-border-default rounded-3xl outline-none focus:ring-4 focus:ring-brand-500/20 focus:border-brand-500 transition-all shadow-lg text-content-primary placeholder:text-content-tertiary"
                    />
                </div>

                {/* Job Listings Grid */}
                {loading ? (
                    <div className="flex justify-center items-center h-48">
                        <div className="w-12 h-12 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : jobs.length === 0 ? (
                    <div className="text-center py-16 bg-surface-card/30 rounded-3xl border border-dashed border-border-default">
                        <svg className="w-12 h-12 mx-auto text-content-tertiary mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        <p className="text-content-secondary text-lg">No open roles match your query.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {jobs.map((job) => (
                            <div 
                                key={job.id} 
                                className="group relative flex flex-col justify-between p-6 sm:p-8 bg-surface-card border border-border-default rounded-3xl hover:border-brand-500/50 hover:bg-surface-card-hover hover:shadow-xl hover:shadow-brand-500/5 transition-all duration-300 cursor-pointer"
                                onClick={() => setSelectedJob(job)}
                            >
                                <div className="space-y-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <h3 className="text-xl sm:text-2xl font-bold text-content-primary group-hover:text-brand-500 transition-colors">
                                                {job.title}
                                            </h3>
                                            <p className="text-content-secondary font-semibold text-sm mt-1">
                                                {job.companyName || "Unknown Company"}
                                            </p>
                                        </div>

                                        {job.matchScore !== null && (
                                            <div className={`px-3.5 py-1.5 rounded-full text-xs font-bold border shrink-0 ${getScoreBadgeColor(job.matchScore)}`}>
                                                {job.matchScore}% Match
                                            </div>
                                        )}
                                    </div>

                                    <p className="text-content-secondary text-sm line-clamp-3">
                                        {job.description}
                                    </p>
                                </div>

                                <div className="mt-6 pt-4 border-t border-border-default flex items-center justify-between">
                                    <span className="text-content-tertiary text-xs font-medium">
                                        Posted on {formatDate(job.createdAt)}
                                    </span>
                                    <span className="text-brand-500 text-sm font-bold group-hover:translate-x-1 transition-transform flex items-center gap-1">
                                        View Details
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Job Detail Modal */}
                {selectedJob && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="w-full max-w-2xl bg-surface-primary rounded-3xl shadow-2xl border border-border-default overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
                            <div className="p-6 sm:p-8 border-b border-border-default flex items-start justify-between gap-4 bg-surface-card">
                                <div>
                                    <h2 className="text-2xl sm:text-3xl font-bold text-content-primary">{selectedJob.title}</h2>
                                    <p className="text-content-secondary font-semibold mt-1">{selectedJob.companyName}</p>
                                </div>
                                <button 
                                    onClick={() => setSelectedJob(null)}
                                    className="p-2 text-content-tertiary hover:text-content-primary hover:bg-surface-tertiary rounded-full transition-all"
                                >
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                                </button>
                            </div>

                            <div className="p-6 sm:p-8 overflow-y-auto space-y-6 flex-1 bg-surface-primary">
                                <div className="space-y-2">
                                    <h4 className="text-sm font-bold text-content-tertiary uppercase tracking-wider">About the Role</h4>
                                    <p className="text-content-secondary whitespace-pre-wrap leading-relaxed">{selectedJob.description}</p>
                                </div>

                                {selectedJob.requirements && (
                                    <div className="space-y-2">
                                        <h4 className="text-sm font-bold text-content-tertiary uppercase tracking-wider">Requirements</h4>
                                        <p className="text-content-secondary whitespace-pre-wrap leading-relaxed">{selectedJob.requirements}</p>
                                    </div>
                                )}
                            </div>

                            <div className="p-6 sm:p-8 bg-surface-secondary border-t border-border-default flex items-center justify-between gap-4">
                                <div className="text-xs text-content-tertiary">
                                    Posted on {new Date(selectedJob.createdAt).toLocaleDateString()}
                                </div>
                                <div className="flex gap-3">
                                    <button 
                                        onClick={() => setSelectedJob(null)}
                                        className="px-5 py-2.5 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all"
                                    >
                                        Close
                                    </button>
                                    <button 
                                        onClick={() => alert("Successfully applied! Recruiter notified.")}
                                        className="px-6 py-2.5 bg-[image:var(--gradient-primary)] text-white font-bold rounded-xl text-sm transition-all shadow-lg hover:shadow-xl"
                                    >
                                        Apply Now
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
