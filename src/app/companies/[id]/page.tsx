"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, useCallback } from "react";

interface CompanyDetail {
    id: string;
    name: string;
    info: string | null;
    createdAt: string;
    updatedAt: string;
    owner: { id: string; name: string | null; email: string; image: string | null };
}

export default function CompanyPage() {
    const { id } = useParams();
    const { data: session } = useSession();
    const router = useRouter();
    const [company, setCompany] = useState<CompanyDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    // Edit state
    const [editing, setEditing] = useState(false);
    const [infoText, setInfoText] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState("");
    const [error, setError] = useState("");

    // Delete state
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const isOwner = session?.user?.id === company?.owner?.id;

    const fetchCompany = useCallback(async () => {
        try {
            const res = await fetch(`/api/companies/${id}`);
            if (res.status === 404) { setNotFound(true); return; }
            const data = await res.json();
            if (res.ok) {
                setCompany(data.company);
                setInfoText(data.company.info || "");
            }
        } catch {
            console.error("Failed to fetch company");
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => { fetchCompany(); }, [fetchCompany]);

    async function handleSaveInfo() {
        setError(""); setSaveMsg(""); setSaving(true);
        try {
            const res = await fetch(`/api/companies/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ info: infoText }),
            });
            const data = await res.json();
            if (!res.ok) { setError(data.error); return; }
            setCompany(data.company);
            setEditing(false);
            setSaveMsg("Info saved successfully!");
            setTimeout(() => setSaveMsg(""), 3000);
        } catch { setError("Failed to save"); }
        finally { setSaving(false); }
    }

    async function handleDelete() {
        setDeleting(true);
        try {
            const res = await fetch(`/api/companies/${id}`, { method: "DELETE" });
            if (res.ok) { router.push("/dashboard/companies"); }
            else { const d = await res.json(); setError(d.error); }
        } catch { setError("Failed to delete"); }
        finally { setDeleting(false); }
    }

    async function handleClearInfo() {
        setError(""); setSaving(true);
        try {
            const res = await fetch(`/api/companies/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ info: "" }),
            });
            const data = await res.json();
            if (res.ok) {
                setCompany(data.company);
                setInfoText("");
                setSaveMsg("Info cleared!");
                setTimeout(() => setSaveMsg(""), 3000);
            }
        } catch { setError("Failed to clear info"); }
        finally { setSaving(false); }
    }

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin-custom" />
                    <span className="text-content-secondary text-sm">Loading company...</span>
                </div>
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="min-h-screen flex items-center justify-center px-6">
                <div className="text-center">
                    <h1 className="text-4xl font-bold text-content-primary font-display mb-3">404</h1>
                    <p className="text-content-secondary mb-6">Company not found.</p>
                    <Link href="/companies" className="text-brand-400 hover:underline text-sm font-medium">← Back to All Companies</Link>
                </div>
            </div>
        );
    }

    if (!company) return null;

    return (
        <div className="min-h-screen py-12 px-6 relative overflow-hidden">
            <div className="absolute -top-[20%] left-[20%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.07)_0%,transparent_70%)] blur-[100px] pointer-events-none" />

            <div className="max-w-3xl mx-auto relative z-10">
                {/* Breadcrumb */}
                <div className="flex items-center gap-2 text-sm text-content-tertiary mb-8">
                    <Link href="/companies" className="hover:text-brand-400 transition-colors no-underline text-content-tertiary">Companies</Link>
                    <span>/</span>
                    <span className="text-content-secondary truncate">{company.name}</span>
                </div>

                {/* Company Header Card */}
                <div className="p-8 rounded-2xl bg-surface-card border border-border-default backdrop-blur-[20px] mb-6 animate-fadeInUp">
                    <div className="flex items-start gap-5">
                        <div className="w-14 h-14 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 shrink-0">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
                            </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-2xl md:text-3xl font-bold text-content-primary font-display truncate">{company.name}</h1>
                            <div className="flex items-center gap-2 mt-3">
                                <div className="w-7 h-7 rounded-full bg-[image:var(--gradient-primary)] flex items-center justify-center text-[0.65rem] font-semibold text-white shrink-0">
                                    {company.owner.name?.charAt(0).toUpperCase() || company.owner.email.charAt(0).toUpperCase()}
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-sm text-content-primary font-medium">{company.owner.name || "Unknown"}</span>
                                    <span className="text-xs text-content-tertiary">{company.owner.email}</span>
                                </div>
                                {isOwner && (
                                    <span className="ml-2 px-2.5 py-0.5 rounded-full text-[0.65rem] font-bold uppercase tracking-wider bg-brand-500/15 text-brand-400 border border-brand-500/25">Owner</span>
                                )}
                            </div>
                            <p className="text-xs text-content-tertiary mt-3">
                                Created {new Date(company.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                                {company.updatedAt !== company.createdAt && ` · Updated ${new Date(company.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Toasts */}
                {saveMsg && (
                    <div className="mb-4 py-3 px-5 rounded-xl bg-success-400/10 border border-success-400/25 text-success-400 text-sm font-medium animate-fadeInUp flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                        {saveMsg}
                    </div>
                )}
                {error && (
                    <div className="mb-4 py-3 px-5 rounded-xl bg-danger-400/10 border border-danger-400/20 text-danger-400 text-sm animate-fadeInUp">{error}</div>
                )}

                {/* Company Info Section */}
                <div className="p-8 rounded-2xl bg-surface-card border border-border-default backdrop-blur-[20px] animate-fadeInUp-1">
                    <div className="flex items-center justify-between mb-5">
                        <h2 className="text-lg font-bold text-content-primary font-display">Company Information</h2>
                        {isOwner && !editing && (
                            <div className="flex items-center gap-2">
                                <button onClick={() => setEditing(true)}
                                    className="inline-flex items-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold text-brand-400 bg-brand-500/10 border border-brand-500/20 hover:bg-brand-500/20 transition-all">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                    Edit
                                </button>
                                {company.info && (
                                    <button onClick={handleClearInfo} disabled={saving}
                                        className="inline-flex items-center gap-1.5 py-2 px-4 rounded-lg text-xs font-semibold text-danger-400 bg-danger-400/10 border border-danger-400/20 hover:bg-danger-400/20 transition-all disabled:opacity-50">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                                        Clear
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {editing && isOwner ? (
                        <div>
                            <textarea
                                id="company-info-textarea"
                                className="form-input-light w-full py-4 px-4 rounded-xl border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary resize-y min-h-[160px]"
                                placeholder="Enter information about your company..."
                                value={infoText}
                                onChange={(e) => setInfoText(e.target.value)}
                                rows={6}
                                autoFocus
                            />
                            <div className="flex gap-3 mt-4">
                                <button onClick={handleSaveInfo} disabled={saving}
                                    className="py-2.5 px-6 rounded-lg text-sm font-semibold text-white bg-brand-600 hover:bg-brand-500 transition-all disabled:opacity-50">
                                    {saving ? "Saving..." : "Save Info"}
                                </button>
                                <button onClick={() => { setEditing(false); setInfoText(company.info || ""); setError(""); }}
                                    className="py-2.5 px-6 rounded-lg text-sm font-medium text-content-secondary bg-surface-tertiary border border-border-default hover:bg-surface-card-hover transition-all">
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div>
                            {company.info ? (
                                <div className="text-content-secondary text-sm leading-relaxed whitespace-pre-wrap rounded-xl bg-surface-secondary/50 p-5 border border-border-default">
                                    {company.info}
                                </div>
                            ) : (
                                <div className="text-center py-10 rounded-xl bg-surface-secondary/30 border border-border-default border-dashed">
                                    <p className="text-content-tertiary text-sm italic">
                                        {isOwner ? "No information added yet. Click \"Edit\" to add details about your company." : "No information has been added to this company yet."}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Delete Section (Owner only) */}
                {isOwner && (
                    <div className="mt-6 p-6 rounded-2xl bg-danger-400/5 border border-danger-400/15 animate-fadeInUp-2">
                        <h3 className="text-sm font-bold text-danger-400 mb-2">Danger Zone</h3>
                        <p className="text-xs text-content-tertiary mb-4">Deleting a company is permanent and cannot be undone.</p>
                        {!showDeleteConfirm ? (
                            <button onClick={() => setShowDeleteConfirm(true)}
                                className="py-2 px-5 rounded-lg text-xs font-semibold text-danger-400 bg-danger-400/10 border border-danger-400/20 hover:bg-danger-400/20 transition-all">
                                Delete Company
                            </button>
                        ) : (
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-content-secondary">Are you sure?</span>
                                <button onClick={handleDelete} disabled={deleting}
                                    className="py-2 px-5 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition-all disabled:opacity-50">
                                    {deleting ? "Deleting..." : "Yes, Delete"}
                                </button>
                                <button onClick={() => setShowDeleteConfirm(false)}
                                    className="py-2 px-5 rounded-lg text-xs font-medium text-content-secondary bg-surface-tertiary border border-border-default hover:bg-surface-card-hover transition-all">
                                    Cancel
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
