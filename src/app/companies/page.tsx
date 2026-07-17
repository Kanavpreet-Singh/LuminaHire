"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface CompanyWithOwner {
    id: string;
    name: string;
    info: string | null;
    createdAt: string;
    owner: {
        id: string;
        name: string | null;
        email: string;
        image: string | null;
    };
}

export default function AllCompaniesPage() {
    const [companies, setCompanies] = useState<CompanyWithOwner[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");

    useEffect(() => {
        async function fetchCompanies() {
            try {
                const res = await fetch("/api/companies");
                const data = await res.json();
                if (res.ok) setCompanies(data.companies);
            } catch {
                console.error("Failed to fetch companies");
            } finally {
                setLoading(false);
            }
        }
        fetchCompanies();
    }, []);

    const filtered = companies.filter((c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.owner.name || "").toLowerCase().includes(search.toLowerCase()) ||
        c.owner.email.toLowerCase().includes(search.toLowerCase())
    );

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin-custom" />
                    <span className="text-content-secondary text-sm">Loading companies...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen py-12 px-6 relative overflow-hidden">
            <div className="absolute -top-[30%] right-[10%] w-[700px] h-[700px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.06)_0%,transparent_70%)] blur-[100px] pointer-events-none" />

            <div className="max-w-6xl mx-auto relative z-10">
                {/* Header */}
                <div className="text-center mb-12">
                    <span className="text-accent-400 text-sm font-bold uppercase tracking-[0.2em] mb-4 block font-sans">✦ Directory</span>
                    <h1 className="text-3xl md:text-5xl font-bold text-content-primary font-display mb-4">
                        All <span className="gradient-text">Companies</span>
                    </h1>
                    <p className="text-content-secondary text-base max-w-xl mx-auto">
                        Browse all companies registered on LuminaHire and see who&apos;s behind each one.
                    </p>
                </div>

                {/* Search */}
                <div className="max-w-lg mx-auto mb-10">
                    <div className="relative">
                        <svg className="absolute left-4 top-1/2 -translate-y-1/2 text-content-tertiary" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                            id="company-search"
                            type="text"
                            className="form-input-light w-full py-3.5 pl-12 pr-4 rounded-xl border border-border-default bg-surface-card text-content-primary text-[0.9rem] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary backdrop-blur-md"
                            placeholder="Search companies or creators..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>

                <p className="text-sm text-content-tertiary mb-6">
                    {filtered.length} {filtered.length === 1 ? "company" : "companies"} found
                </p>

                {filtered.length === 0 ? (
                    <div className="text-center py-16">
                        <div className="w-16 h-16 rounded-2xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center mx-auto mb-5">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-bold text-content-primary mb-2 font-display">No Companies Found</h3>
                        <p className="text-content-secondary text-sm">
                            {search ? "Try a different search query." : "No companies have been created yet."}
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {filtered.map((company) => (
                            <Link key={company.id} href={`/companies/${company.id}`}
                                className="group relative flex items-start gap-5 p-6 rounded-2xl bg-surface-card border border-border-default hover:border-brand-500/40 hover:bg-surface-card-hover transition-all duration-300 no-underline">
                                <div className="w-12 h-12 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 group-hover:scale-110 transition-transform shrink-0">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
                                    </svg>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-base font-bold text-content-primary group-hover:text-brand-400 transition-colors truncate">{company.name}</h3>
                                    <div className="flex items-center gap-2 mt-2">
                                        <div className="w-6 h-6 rounded-full bg-[image:var(--gradient-primary)] flex items-center justify-center text-[0.6rem] font-semibold text-white shrink-0">
                                            {company.owner.name?.charAt(0).toUpperCase() || company.owner.email.charAt(0).toUpperCase()}
                                        </div>
                                        <span className="text-xs text-content-secondary truncate">{company.owner.name || company.owner.email}</span>
                                    </div>
                                    {company.info && <p className="mt-2.5 text-xs text-content-tertiary line-clamp-2">{company.info}</p>}
                                </div>
                                <span className="text-[0.65rem] text-content-tertiary whitespace-nowrap mt-1 shrink-0">
                                    {new Date(company.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                </span>
                            </Link>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
