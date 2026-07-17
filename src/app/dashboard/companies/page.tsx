"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback } from "react";

interface Company {
    id: string;
    name: string;
    info: string | null;
    pdfUrl: string | null;
    createdAt: string;
    updatedAt: string;
}

export default function MyCompaniesPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [companies, setCompanies] = useState<Company[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [companyName, setCompanyName] = useState("");
    const [companyInfo, setCompanyInfo] = useState("");
    const [companyPdf, setCompanyPdf] = useState<File | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");
    const [successMsg, setSuccessMsg] = useState("");

    const fetchCompanies = useCallback(async () => {
        try {
            const res = await fetch("/api/companies/my");
            const data = await res.json();
            if (res.ok) {
                setCompanies(data.companies);
            }
        } catch {
            console.error("Failed to fetch companies");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (status === "unauthenticated") {
            router.replace("/login");
        }
        if (status === "authenticated") {
            fetchCompanies();
        }
    }, [status, router, fetchCompanies]);

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        setSuccessMsg("");
        setCreating(true);

        try {
            const formData = new FormData();
            formData.append("name", companyName);
            formData.append("info", companyInfo);

            if (companyPdf) {
                formData.append("pdf", companyPdf);
            }

            const res = await fetch("/api/companies", {
                method: "POST",
                body: formData,
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data.error || "Failed to create company");
                return;
            }

            setSuccessMsg(`"${data.company.name}" created successfully!`);
            setCompanyName("");
            setCompanyInfo("");
            setCompanyPdf(null);
            setShowCreateForm(false);
            fetchCompanies();
            setTimeout(() => setSuccessMsg(""), 3000);
        } catch {
            setError("Something went wrong. Please try again.");
        } finally {
            setCreating(false);
        }
    }

    if (status === "loading" || (status === "authenticated" && loading)) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin-custom" />
                    <span className="text-content-secondary text-sm">Loading your companies...</span>
                </div>
            </div>
        );
    }

    if (!session) return null;

    return (
        <div className="min-h-screen py-12 px-6 relative overflow-hidden">
            {/* Background glow */}
            <div className="absolute -top-[30%] left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.08)_0%,transparent_70%)] blur-[100px] pointer-events-none" />

            <div className="max-w-5xl mx-auto relative z-10">
                {/* Header */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-10">
                    <div>
                        <h1 className="text-3xl md:text-4xl font-bold text-content-primary font-display mb-2">
                            My <span className="gradient-text">Companies</span>
                        </h1>
                        <p className="text-content-secondary text-[0.95rem]">
                            Manage and oversee all companies you&apos;ve created.
                        </p>
                    </div>
                    <button
                        onClick={() => { setShowCreateForm(!showCreateForm); setError(""); }}
                        className="group inline-flex items-center gap-2 py-3 px-6 rounded-full text-sm font-semibold text-white bg-[image:var(--gradient-primary)] transition-all duration-300 shadow-glow hover:-translate-y-px hover:shadow-glow-strong"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="group-hover:rotate-90 transition-transform duration-300">
                            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Create Company
                    </button>
                </div>

                {/* Success Toast */}
                {successMsg && (
                    <div className="mb-6 py-3.5 px-5 rounded-xl bg-success-400/10 border border-success-400/25 text-success-400 text-sm font-medium animate-fadeInUp flex items-center gap-2">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                        {successMsg}
                    </div>
                )}

                {/* Create Company Form */}
                {showCreateForm && (
                    <div className="mb-8 p-6 rounded-2xl bg-surface-card border border-border-default backdrop-blur-[20px] animate-fadeInUp">
                        <h2 className="text-lg font-bold text-content-primary mb-4 font-display">Create a New Company</h2>
                        <form onSubmit={handleCreate} className="space-y-4">
                            <div>
                                <input
                                    id="company-name-input"
                                    type="text"
                                    className="form-input-light w-full py-3 px-4 rounded-lg border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                                    placeholder="Enter company name..."
                                    value={companyName}
                                    onChange={(e) => setCompanyName(e.target.value)}
                                    required
                                    maxLength={100}
                                    autoFocus
                                />
                            </div>
                            <textarea
                                className="form-input-light w-full py-3 px-4 rounded-lg border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary resize-y min-h-[120px]"
                                placeholder="Optional company info..."
                                value={companyInfo}
                                onChange={(e) => setCompanyInfo(e.target.value)}
                            />
                            <div>
                                <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-content-tertiary mb-2">
                                    Optional PDF
                                </label>
                                <input
                                    type="file"
                                    accept="application/pdf"
                                    className="block w-full text-sm text-content-secondary file:mr-4 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-500"
                                    onChange={(e) => setCompanyPdf(e.target.files?.[0] ?? null)}
                                />
                                {companyPdf && (
                                    <p className="mt-2 text-xs text-content-tertiary">Selected: {companyPdf.name}</p>
                                )}
                            </div>
                            <div className="flex gap-3">
                                <button
                                    type="submit"
                                    disabled={creating || !companyName.trim()}
                                    className="py-3 px-6 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-500 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:not-disabled:-translate-y-px"
                                >
                                    {creating ? "Creating..." : "Create"}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setShowCreateForm(false); setError(""); setCompanyName(""); setCompanyInfo(""); setCompanyPdf(null); }}
                                    className="py-3 px-6 rounded-lg text-sm font-medium text-content-secondary bg-surface-tertiary border border-border-default hover:bg-surface-card-hover transition-all duration-200"
                                >
                                    Cancel
                                </button>
                            </div>
                        </form>
                        {error && (
                            <div className="mt-4 py-3 px-4 rounded-lg bg-danger-400/10 border border-danger-400/20 text-danger-400 text-sm animate-fadeInUp">
                                {error}
                            </div>
                        )}
                    </div>
                )}

                {/* Companies Grid */}
                {companies.length === 0 ? (
                    <div className="text-center py-20">
                        <div className="w-20 h-20 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mx-auto mb-6">
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
                            </svg>
                        </div>
                        <h3 className="text-xl font-bold text-content-primary mb-2 font-display">No Companies Yet</h3>
                        <p className="text-content-secondary text-sm mb-6 max-w-md mx-auto">
                            You haven&apos;t created any companies yet. Click &quot;Create Company&quot; above to get started.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {companies.map((company, i) => (
                            <Link
                                key={company.id}
                                href={`/companies/${company.id}`}
                                className={`group relative p-6 rounded-2xl bg-surface-card border border-border-default hover:border-brand-500/50 hover:bg-surface-card-hover transition-all duration-300 no-underline animate-fadeInUp-${Math.min(i, 4)}`}
                            >
                                {/* Top accent line */}
                                <div className="absolute top-0 left-4 right-4 h-[2px] bg-[image:var(--gradient-primary)] opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-full" />

                                <div className="flex items-start gap-4">
                                    <div className="w-11 h-11 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 group-hover:scale-110 transition-transform shrink-0">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
                                        </svg>
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-base font-bold text-content-primary group-hover:text-brand-400 transition-colors truncate">
                                            {company.name}
                                        </h3>
                                        <p className="text-xs text-content-tertiary mt-1">
                                            Created {new Date(company.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                        </p>
                                    </div>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-content-tertiary group-hover:text-brand-400 group-hover:translate-x-1 transition-all mt-1 shrink-0">
                                        <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                </div>

                                {company.info && (
                                    <p className="mt-3 text-xs text-content-secondary line-clamp-2 leading-relaxed">
                                        {company.info}
                                    </p>
                                )}

                                {!company.info && (
                                    <p className="mt-3 text-xs text-content-tertiary italic">
                                        No info added yet — click to add details
                                    </p>
                                )}
                            </Link>
                        ))}
                    </div>
                )}

                {/* Bottom navigation */}
                <div className="mt-12 text-center">
                    <Link
                        href="/companies"
                        className="inline-flex items-center gap-2 text-sm font-medium text-content-secondary hover:text-brand-400 transition-colors no-underline"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                        Browse All Companies
                    </Link>
                </div>
            </div>
        </div>
    );
}
