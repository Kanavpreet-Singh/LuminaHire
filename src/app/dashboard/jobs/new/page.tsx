"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

export default function NewJobPage() {
    const router = useRouter();
    const { data: session, status } = useSession();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [requirements, setRequirements] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [profile, setProfile] = useState<any>(null);
    const [fetchingProfile, setFetchingProfile] = useState(true);

    useEffect(() => {
        if (status === "unauthenticated") {
            router.push("/login");
            return;
        }

        if (status === "authenticated") {
            fetch("/api/profile")
                .then(res => res.json())
                .then(data => {
                    setProfile(data);
                    setFetchingProfile(false);
                })
                .catch(() => setFetchingProfile(false));
        }
    }, [status, router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            const res = await fetch("/api/jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, description, requirements }),
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || "Failed to create job");
            }

            // Redirect on success
            router.push("/dashboard");
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex-1 bg-surface-primary text-content-primary py-12 px-4 sm:px-6 lg:px-8 flex items-center justify-center relative">
            {/* Background mesh glows with contained overflow */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                <div className="absolute inset-0 hero-grid-pattern opacity-30" />
                <div className="absolute -top-[20%] left-[10%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.06)_0%,transparent_70%)] blur-[100px]" />
                <div className="absolute -bottom-[20%] right-[10%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.05)_0%,transparent_70%)] blur-[100px]" />
            </div>

            <div className="w-full max-w-3xl backdrop-blur-xl bg-surface-card p-8 sm:p-12 rounded-3xl border border-border-default transition-all duration-300 relative z-10 shadow-2xl">
                <div className="text-center mb-10">
                    <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 tracking-tight mb-2">
                        Post a New Role
                    </h1>
                    <p className="text-content-secondary text-lg">
                        Attract top AI-matched talent by defining your job details below.
                    </p>
                </div>

                {fetchingProfile || status === "loading" ? (
                    <div className="flex justify-center items-center h-32">
                        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : profile?.role !== "RECRUITER" ? (
                    <div className="text-center py-8">
                        <h3 className="text-xl font-bold text-content-primary mb-3">Unauthorized</h3>
                        <p className="text-content-secondary mb-6">
                            You must be a Recruiter to post a job.
                        </p>
                    </div>
                ) : !profile?.user?.companyName && !profile?.companyName ? (
                    <div className="text-center py-8">
                        <h3 className="text-xl font-bold text-content-primary mb-3">Company Name Required!</h3>
                        <p className="text-content-secondary mb-6">
                            Before posting a job, please update your profile with your company name.
                        </p>
                        <button
                            onClick={() => router.push("/profile")}
                            className="inline-flex py-3 px-6 bg-[image:var(--gradient-primary)] text-white font-bold rounded-xl shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all cursor-pointer"
                        >
                            Update Profile
                        </button>
                    </div>
                ) : (
                    <>
                        {error && (
                            <div className="animate-in fade-in slide-in-from-top-2 bg-rose-500/10 text-rose-600 dark:text-rose-400 p-4 rounded-xl mb-8 text-sm font-semibold border border-rose-500/25 flex items-center">
                                <svg className="w-5 h-5 mr-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                {error}
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-8">
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-secondary ml-1">Job Title</label>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    required
                                    className="w-full px-5 py-4 bg-surface-secondary border border-border-default rounded-2xl focus:border-brand-500 focus:shadow-[0_0_0_4px_rgba(124,58,237,0.1)] outline-none transition-all text-content-primary text-lg shadow-inner placeholder:text-content-tertiary"
                                    placeholder="e.g. Senior Machine Learning Engineer"
                                />
                            </div>
                            
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-secondary ml-1">Job Description</label>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    required
                                    rows={6}
                                    className="w-full px-5 py-4 bg-surface-secondary border border-border-default rounded-2xl focus:border-brand-500 focus:shadow-[0_0_0_4px_rgba(124,58,237,0.1)] outline-none transition-all text-content-primary shadow-inner placeholder:text-content-tertiary resize-none"
                                    placeholder="Describe the overarching goal, team, and day-to-day responsibilities..."
                                />
                            </div>
                            
                            <div className="space-y-2">
                                <label className="block text-sm font-bold text-content-secondary ml-1">Requirements (Optional)</label>
                                <textarea
                                    value={requirements}
                                    onChange={(e) => setRequirements(e.target.value)}
                                    rows={4}
                                    className="w-full px-5 py-4 bg-surface-secondary border border-border-default rounded-2xl focus:border-brand-500 focus:shadow-[0_0_0_4px_rgba(124,58,237,0.1)] outline-none transition-all text-content-primary shadow-inner placeholder:text-content-tertiary resize-none"
                                    placeholder="Specific skills, years of experience, tools, education..."
                                />
                            </div>

                            <div className="pt-4 flex gap-4">
                                <button
                                    type="button"
                                    onClick={() => router.push("/dashboard")}
                                    className="flex-1 py-4 border border-border-default text-lg font-bold rounded-2xl text-content-secondary bg-surface-tertiary hover:bg-surface-secondary transition-all text-center cursor-pointer"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="flex-[2] group relative flex justify-center py-4 px-4 border border-transparent text-lg font-bold rounded-2xl text-white bg-[image:var(--gradient-primary)] hover:opacity-95 disabled:opacity-70 disabled:cursor-wait shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all overflow-hidden cursor-pointer"
                                >
                                    {loading ? (
                                        <span className="flex items-center">
                                            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                            </svg>
                                            Generating AI Embeddings...
                                        </span>
                                    ) : (
                                        "Publish Job Posting"
                                    )}
                                </button>
                            </div>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
