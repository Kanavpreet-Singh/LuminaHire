"use client";

import { useState, useEffect } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
    const router = useRouter();
    const { status } = useSession();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [role, setRole] = useState<"RECRUITER" | "CANDIDATE">("CANDIDATE");
    const [companyName, setCompanyName] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [googleLoading, setGoogleLoading] = useState(false);
    const [showGoogleHint, setShowGoogleHint] = useState(false);

    useEffect(() => {
        if (status === "authenticated") {
            router.replace("/");
        }
    }, [status, router]);

    if (status === "authenticated") return null;

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        setShowGoogleHint(false);

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            return;
        }

        setLoading(true);

        try {
            const res = await fetch("/api/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, password, role, companyName }),
            });

            const data = await res.json();

            if (!res.ok) {
                if (data.code === "GOOGLE_ACCOUNT") {
                    setShowGoogleHint(true);
                    setError(data.error);
                } else {
                    setError(data.error || "Registration failed");
                }
                return;
            }

            const result = await signIn("credentials", {
                email,
                password,
                redirect: false,
            });

            if (result?.error) {
                router.push("/login");
            } else {
                router.push("/");
                router.refresh();
            }
        } catch {
            setError("Something went wrong. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    async function handleGoogleSignIn() {
        setGoogleLoading(true);
        setError("");
        setShowGoogleHint(false);
        try {
            // Store the intended role in a cookie so the backend can read it during OAuth callback
            document.cookie = `intended_role=${role}; path=/; max-age=3600`;
            await signIn("google", { callbackUrl: "/" });
        } catch {
            setError("Google sign-in failed. Please try again.");
            setGoogleLoading(false);
        }
    }

    return (
        <div className="flex-1 flex items-center justify-center py-8 px-6 relative bg-surface-primary text-content-primary">
            {/* Background grid & glows with contained overflow */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                <div className="absolute inset-0 hero-grid-pattern opacity-30" />
                <div className="absolute -top-[40%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.08)_0%,transparent_70%)] blur-[80px]" />
            </div>

            {/* Auth Card */}
            <div className="auth-card-light relative w-full max-w-[440px] p-10 max-md:p-7 rounded-xl bg-surface-card border border-border-default backdrop-blur-[20px] z-10 shadow-2xl">
                {/* Header */}
                <div className="text-center mb-8">
                    <Link href="/" className="no-underline">
                        <div className="flex items-center justify-center w-10 h-10 rounded-md bg-[image:var(--gradient-primary)] text-white mx-auto mb-4">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                        </div>
                    </Link>
                    <h1 className="text-2xl font-bold mb-2 text-content-primary font-display">Create your account</h1>
                    <p className="text-[0.9rem] text-content-secondary">Start documenting your technical decisions with AI</p>
                </div>

                {/* Google Sign-Up */}
                <button
                    onClick={handleGoogleSignIn}
                    disabled={googleLoading}
                    className={`btn-google-light flex items-center justify-center gap-3 w-full py-3 rounded-md text-[0.9rem] font-medium font-[var(--font-sans)] text-content-primary bg-surface-secondary border border-border-default cursor-pointer transition-all duration-200 hover:not-disabled:bg-surface-tertiary hover:not-disabled:border-border-hover hover:not-disabled:-translate-y-px hover:not-disabled:shadow-sm disabled:opacity-60 disabled:cursor-not-allowed ${showGoogleHint ? "animate-google-pulse" : ""}`}
                    type="button"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    {googleLoading ? "Redirecting..." : "Continue with Google"}
                </button>

                {/* Divider */}
                <div className="auth-divider-line flex items-center gap-4 my-6">
                    <span className="text-[0.78rem] text-content-tertiary whitespace-nowrap uppercase tracking-[0.05em] font-medium">or register with email</span>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                    {error && (
                        <div className={showGoogleHint
                            ? "form-warning-light py-3.5 px-4 rounded-md bg-warning-500/10 border border-warning-500/25 text-warning-600 dark:text-warning-300 text-[0.85rem] flex flex-col gap-3 animate-fadeInUp"
                            : "py-3 px-4 rounded-md bg-danger-500/10 border border-danger-500/25 text-danger-600 dark:text-danger-400 text-[0.85rem]"
                        }>
                            <span>{error}</span>
                            {showGoogleHint && (
                                <button
                                    type="button"
                                    className="inline-flex items-center gap-2 py-2 px-3.5 rounded-sm text-[0.82rem] font-semibold font-[var(--font-sans)] text-content-primary bg-surface-secondary border border-border-default cursor-pointer transition-all duration-200 w-fit hover:bg-surface-tertiary hover:border-border-hover hover:-translate-y-px"
                                    onClick={handleGoogleSignIn}
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24">
                                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                                    </svg>
                                    Sign in with Google instead
                                </button>
                            )}
                        </div>
                    )}

                    <div className="flex bg-surface-secondary border border-border-default rounded-md p-1 gap-1">
                        <button
                            type="button"
                            onClick={() => setRole("CANDIDATE")}
                            className={`flex-1 py-2 text-sm font-medium rounded-sm transition-all duration-200 ${
                                role === "CANDIDATE" 
                                    ? "bg-[image:var(--gradient-primary)] text-white shadow-md" 
                                    : "text-content-secondary hover:text-content-primary"
                            }`}
                        >
                            Candidate
                        </button>
                        <button
                            type="button"
                            onClick={() => setRole("RECRUITER")}
                            className={`flex-1 py-2 text-sm font-medium rounded-sm transition-all duration-200 ${
                                role === "RECRUITER" 
                                    ? "bg-[image:var(--gradient-primary)] text-white shadow-md" 
                                    : "text-content-secondary hover:text-content-primary"
                            }`}
                        >
                            Recruiter
                        </button>
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="name" className="text-[0.85rem] font-medium text-content-secondary">Full Name</label>
                        <input
                            id="name"
                            type="text"
                            className="form-input-light w-full py-3 px-4 rounded-md border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                            placeholder="John Doe"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            autoFocus
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="email" className="text-[0.85rem] font-medium text-content-secondary">Email</label>
                        <input
                            id="email"
                            type="email"
                            className="form-input-light w-full py-3 px-4 rounded-md border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>

                    {role === "RECRUITER" && (
                        <div className="flex flex-col gap-2">
                            <label htmlFor="companyName" className="text-[0.85rem] font-medium text-content-secondary">Company Name</label>
                            <input
                                id="companyName"
                                type="text"
                                className="form-input-light w-full py-3 px-4 rounded-md border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                                placeholder="Acme Corp"
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                required
                            />
                        </div>
                    )}

                    <div className="flex flex-col gap-2">
                        <label htmlFor="password" className="text-[0.85rem] font-medium text-content-secondary">Password</label>
                        <input
                            id="password"
                            type="password"
                            className="form-input-light w-full py-3 px-4 rounded-md border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                            placeholder="Min. 6 characters"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={6}
                        />
                    </div>

                    <div className="flex flex-col gap-2">
                        <label htmlFor="confirmPassword" className="text-[0.85rem] font-medium text-content-secondary">Confirm Password</label>
                        <input
                            id="confirmPassword"
                            type="password"
                            className="form-input-light w-full py-3 px-4 rounded-md border border-border-default bg-surface-secondary text-content-primary text-[0.9rem] font-[var(--font-sans)] transition-all duration-200 outline-none focus:border-brand-500 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)] placeholder:text-content-tertiary"
                            placeholder="Re-enter your password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            minLength={6}
                        />
                    </div>

                    <button
                        type="submit"
                        className="w-full py-3 rounded-md text-[0.95rem] font-semibold text-white bg-[image:var(--gradient-primary)] border-none cursor-pointer transition-all duration-300 shadow-glow font-[var(--font-sans)] hover:not-disabled:-translate-y-px hover:not-disabled:shadow-glow-strong disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={loading}
                    >
                        {loading ? "Creating account..." : "Create Account"}
                    </button>
                </form>

                {/* Footer Link */}
                <div className="text-center mt-6 text-[0.85rem] text-content-secondary">
                    Already have an account?{" "}
                    <Link href="/login" className="text-brand-400 no-underline font-medium hover:underline">Sign in</Link>
                </div>
            </div>
        </div>
    );
}
