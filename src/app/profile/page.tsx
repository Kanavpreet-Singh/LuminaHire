"use client";

import { useState, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { UploadDropzone } from "@/utils/uploadthing";
import "@uploadthing/react/styles.css";

export default function ProfilePage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [resumeUrl, setResumeUrl] = useState<string | null>(null);
    const [initialResumeUrl, setInitialResumeUrl] = useState<string | null>(null);
    const [phone, setPhone] = useState("");
    const [initialPhone, setInitialPhone] = useState("");
    const [isRecruiter, setIsRecruiter] = useState(false);
    const [feedback, setFeedback] = useState<{
        type: "success" | "warning" | "error";
        message: string;
    } | null>(null);

    const hasChanges = phone !== initialPhone || resumeUrl !== initialResumeUrl;

    const resumeFileName = (() => {
        if (!resumeUrl) return null;
        try {
            const parsed = new URL(resumeUrl);
            const name = parsed.pathname.split("/").filter(Boolean).pop();
            return name || "resume.pdf";
        } catch {
            return "resume.pdf";
        }
    })();

    useEffect(() => {
        if (status === "unauthenticated") {
            router.push("/login");
        } else if (status === "authenticated") {
            fetchProfile();
        }
    }, [status, router]);

    const fetchProfile = async () => {
        try {
            const res = await fetch("/api/profile");
            
            if (!res.ok) {
                if (res.status === 404 || res.status === 401) {
                    // Database was wiped but browser still has a session cookie (Ghost session)
                    await signOut({ redirect: false });
                    router.push("/login");
                    return;
                }
                throw new Error("Failed to fetch profile");
            }

            const data = await res.json();
            
            if (data.role === "RECRUITER") {
                setIsRecruiter(true);
                setLoading(false);
                return;
            }

            if (data.candidate) {
                setPhone(data.candidate.phone || "");
                setResumeUrl(data.candidate.resumeUrl || null);
                setInitialPhone(data.candidate.phone || "");
                setInitialResumeUrl(data.candidate.resumeUrl || null);
            }
        } catch (error) {
            console.error("Failed to fetch profile", error);
            setFeedback({
                type: "error",
                message: "Unable to load profile right now. Please refresh and try again.",
            });
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setFeedback(null);

        try {
            const res = await fetch("/api/profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resumeUrl, phone }),
            });
            
            if (res.ok) {
                const data = await res.json();
                setInitialPhone(phone);
                setInitialResumeUrl(resumeUrl);

                if (data.embedding?.status === "failed") {
                    const rawError = data.embedding.error || "";
                    const isQuotaError = /quota|credit|billing|resource_exhausted|rate limit/i.test(rawError);
                    setFeedback({
                        type: "warning",
                        message: isQuotaError
                            ? "Profile saved, but Gemini API credits/quota appear exhausted. Please recharge or enable billing for your GEMINI_API_KEY, then click Save Profile again."
                            : "Profile saved, but resume processing failed. AI matching may not be accurate until you re-upload. " +
                              (rawError ? `(${rawError})` : ""),
                    });
                } else if (data.embedding?.status === "success") {
                    setFeedback({
                        type: "success",
                        message: "Profile saved and resume vectorized successfully. AI matching is active.",
                    });
                } else {
                    setFeedback({
                        type: "success",
                        message: "Profile updated successfully.",
                    });
                }
            } else {
                setFeedback({
                    type: "error",
                    message: "Failed to update profile. Please try again.",
                });
            }
        } catch (error) {
            setFeedback({
                type: "error",
                message: "Something went wrong while saving your profile.",
            });
        } finally {
            setSaving(false);
        }
    };

    if (loading || status === "loading") {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin-custom" />
            </div>
        );
    }

    if (isRecruiter) {
        return (
            <div className="min-h-screen py-24 px-6 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 rounded-2xl bg-brand-500/10 flex items-center justify-center mb-6">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="8.5" cy="7" r="4"></circle>
                        <polyline points="17 11 19 13 23 9"></polyline>
                    </svg>
                </div>
                <h1 className="text-3xl font-bold text-content-primary font-display mb-4">Recruiter Profile</h1>
                <p className="text-content-secondary max-w-md mx-auto mb-8">
                    You are logged in as a Recruiter. Head over to the dashboard to post jobs and review candidates.
                </p>
                <button onClick={() => router.push("/dashboard/companies")} className="py-2.5 px-6 rounded-full text-sm font-semibold text-white bg-[image:var(--gradient-primary)] transition-all hover:shadow-glow">
                    Go to Dashboard
                </button>
            </div>
        );
    }

    return (
        <div className="min-h-screen py-24 px-6 relative overflow-hidden flex items-center justify-center">
            {/* Background glow */}
            <div className="absolute -top-[30%] right-[10%] w-[700px] h-[700px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.08)_0%,transparent_70%)] blur-[100px] pointer-events-none" />

            <div className="max-w-xl w-full relative z-10">
                <div className="text-center mb-10">
                    <h1 className="text-3xl md:text-5xl font-bold text-content-primary font-display mb-4">
                        My <span className="gradient-text">Profile</span>
                    </h1>
                    <p className="text-content-secondary text-base">
                        Keep your resume updated to ensure AI matches you with the best roles.
                    </p>
                    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                        <span className="px-3 py-1 rounded-full text-xs border border-sky-400/30 bg-sky-500/10 text-sky-200">AI Matching Ready</span>
                        <span className="px-3 py-1 rounded-full text-xs border border-emerald-400/30 bg-emerald-500/10 text-emerald-200">PDF Resume Upload</span>
                        <span className="px-3 py-1 rounded-full text-xs border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200">Instant Embeddings</span>
                    </div>
                </div>

                <div className="auth-card-light p-8 md:p-10 rounded-2xl bg-surface-card border border-border-default backdrop-blur-[20px] shadow-2xl">
                    <form onSubmit={handleSave} className="flex flex-col gap-6">
                        {feedback && (
                            <div
                                className={`rounded-xl border px-4 py-3 text-sm ${
                                    feedback.type === "success"
                                        ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                                        : feedback.type === "warning"
                                          ? "border-amber-400/40 bg-amber-500/10 text-amber-100"
                                          : "border-rose-400/40 bg-rose-500/10 text-rose-100"
                                }`}
                            >
                                {feedback.message}
                            </div>
                        )}
                        
                        <div className="flex flex-col gap-2">
                            <label className="text-[0.85rem] font-medium text-content-secondary">Name & Email</label>
                            <input
                                type="text"
                                disabled
                                className="form-input-light w-full py-3 px-4 rounded-xl border border-border-default bg-surface-tertiary text-content-tertiary text-[0.9rem] font-[var(--font-sans)] opacity-70 cursor-not-allowed"
                                value={`${session?.user?.name || "No name"} (${session?.user?.email})`}
                            />
                        </div>

                        <div className="flex flex-col gap-2">
                            <label htmlFor="phone" className="text-[0.85rem] font-medium text-content-secondary">Phone Number</label>
                            <input
                                id="phone"
                                type="tel"
                                className="form-input-light w-full py-3 px-4 rounded-xl border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500"
                                placeholder="+1 (555) 000-0000"
                                value={phone}
                                onChange={(e) => {
                                    setPhone(e.target.value);
                                    if (feedback) setFeedback(null);
                                }}
                            />
                        </div>

                        <div className="relative overflow-hidden rounded-2xl border border-border-default bg-gradient-to-br from-surface-secondary via-surface-card to-surface-tertiary p-5 md:p-6">
                            <div className="pointer-events-none absolute -top-12 -right-12 h-44 w-44 rounded-full bg-cyan-400/10 blur-2xl" />
                            <div className="relative z-10 flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-sm font-semibold text-content-primary">Resume Intelligence</p>
                                    <p className="mt-1 text-xs text-content-secondary">
                                        Upload your latest PDF resume to improve semantic matching quality.
                                    </p>
                                </div>
                                <span
                                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border ${
                                        resumeUrl
                                            ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                                            : "border-border-default bg-surface-tertiary text-content-secondary"
                                    }`}
                                >
                                    {resumeUrl ? "Resume Uploaded" : "Resume Missing"}
                                </span>
                            </div>

                            <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-content-secondary md:grid-cols-3">
                                <div className="rounded-lg border border-border-default bg-surface-card/60 px-3 py-2">ATS-friendly PDF format</div>
                                <div className="rounded-lg border border-border-default bg-surface-card/60 px-3 py-2">Text extraction + OCR fallback</div>
                                <div className="rounded-lg border border-border-default bg-surface-card/60 px-3 py-2">Embeddings on Save Profile</div>
                            </div>

                            <div className="mt-5 flex flex-col gap-2">
                                <label className="text-[0.85rem] font-medium text-content-secondary">Resume (PDF)</label>

                            {!resumeUrl ? (
                                <UploadDropzone
                                    endpoint="resumeUploader"
                                    onClientUploadComplete={(res) => {
                                        if (res && res.length > 0) {
                                            setResumeUrl(res[0].url);
                                            setFeedback({
                                                type: "success",
                                                message: "Resume uploaded. Click Save Profile to generate embeddings.",
                                            });
                                        }
                                    }}
                                    onUploadError={(error: Error) => {
                                        setFeedback({
                                            type: "error",
                                            message: `Upload failed: ${error.message}`,
                                        });
                                    }}
                                    appearance={{
                                        container: "border-2 border-dashed border-cyan-400/40 hover:border-cyan-300 bg-cyan-500/5 hover:bg-cyan-500/10 rounded-xl p-8 transition-all",
                                        button: "bg-[image:var(--gradient-primary)] text-white font-sans text-sm py-2 px-4 rounded-md mt-4 shadow-glow",
                                        label: "text-cyan-200 hover:text-cyan-100 transition-colors",
                                        allowedContent: "text-content-tertiary text-xs mt-2"
                                    }}
                                />
                            ) : (
                                <div className="relative w-full border border-emerald-400/30 bg-emerald-500/10 rounded-xl p-5 md:p-6 flex flex-col items-start justify-center transition-all duration-200">
                                    <div className="flex flex-col items-center text-center gap-3">
                                        <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center">
                                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                                <polyline points="14 2 14 8 20 8"></polyline>
                                            </svg>
                                        </div>
                                        <div>
                                            <p className="text-content-primary font-medium text-sm">Resume is active in LuminaHire.</p>
                                            <p className="text-xs text-content-secondary mt-1">{resumeFileName}</p>
                                        </div>
                                        <div className="flex items-center gap-3 mt-2">
                                            <a
                                                href={resumeUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-cyan-200 text-xs font-medium hover:underline"
                                            >
                                                Preview PDF
                                            </a>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setResumeUrl(null);
                                                    if (feedback) setFeedback(null);
                                                }}
                                                className="text-rose-200 text-xs font-medium cursor-pointer hover:underline bg-transparent border-none"
                                            >
                                                Replace Resume
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            </div>
                        </div>

                        <button
                            type="submit"
                            className="w-full py-3.5 mt-4 rounded-xl text-[0.95rem] font-bold text-white bg-[image:var(--gradient-primary)] border-none cursor-pointer transition-all duration-300 shadow-glow hover:not-disabled:-translate-y-px hover:not-disabled:shadow-glow-strong disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed flex justify-center items-center"
                            disabled={saving || !hasChanges}
                        >
                            {saving
                                ? resumeUrl !== initialResumeUrl
                                    ? "Saving & Generating Embeddings..."
                                    : "Saving Changes..."
                                : "Save Profile"}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
