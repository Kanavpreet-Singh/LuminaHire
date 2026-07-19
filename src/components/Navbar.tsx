"use client";

import { useSession, signOut, signIn } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import { DEMO_RECRUITER } from "@/lib/demo";

export default function Navbar() {
    const { data: session, status } = useSession();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [demoLoading, setDemoLoading] = useState(false);

    async function handleDemoLogin() {
        if (demoLoading) return;
        setDemoLoading(true);
        try {
            // Make sure the demo recruiter account exists, then sign in as them.
            await fetch("/api/demo-recruiter", { method: "POST" });
            const result = await signIn("credentials", {
                email: DEMO_RECRUITER.email,
                password: DEMO_RECRUITER.password,
                redirect: false,
            });
            if (result?.error) {
                setDemoLoading(false);
                return;
            }
            // Full navigation so the new session is picked up everywhere.
            window.location.href = "/dashboard";
        } catch {
            setDemoLoading(false);
        }
    }

    return (
        <nav className="navbar-glass fixed top-0 left-0 right-0 z-[1000] backdrop-blur-[20px] border-b border-border-default transition-all duration-300">
            <div className="max-w-[1280px] mx-auto px-6 h-[72px] flex items-center justify-between">
                {/* Logo */}
                <a href="/" className="flex items-center gap-2.5 no-underline text-content-primary font-bold text-xl">
                    <div className="flex items-center justify-center w-10 h-10 rounded-md bg-[image:var(--gradient-primary)] text-white">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </div>
                    <span className="gradient-text text-[1.375rem] tracking-[-0.02em] font-bold">LuminaHire</span>
                </a>

                {/* Desktop Navigation */}
                <div className="hidden md:flex gap-8">
                    {session?.user ? (
                        (session.user as any).role === "RECRUITER" ? (
                            <>
                                <Link href="/dashboard" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Dashboard</Link>
                                <Link href="/profile" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">My Profile</Link>
                            </>
                        ) : (
                            <>
                                <Link href="/jobs" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Explore Jobs</Link>
                                <Link href="/profile" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">My Profile</Link>
                            </>
                        )
                    ) : (
                        <>
                            <a href="/#features" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Features</a>
                            <a href="/#how-it-works" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">How It Works</a>
                            <a href="/#pricing" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Pricing</a>
                        </>
                    )}
                </div>

                {/* Desktop Auth */}
                <div className="hidden md:flex items-center gap-3">
                    <ThemeToggle />
                    <div className="flex items-center gap-3">
                        {status === "loading" ? (
                            <div className="w-[120px] h-9 bg-surface-tertiary rounded-full animate-pulse-custom" />
                        ) : session?.user ? (
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-full bg-[image:var(--gradient-primary)] flex items-center justify-center font-semibold text-sm text-white shrink-0">
                                    {session.user.name?.charAt(0).toUpperCase() || session.user.email?.charAt(0).toUpperCase() || "U"}
                                </div>
                                <div className="flex flex-col leading-tight">
                                    <span className="text-[0.85rem] font-semibold text-content-primary">{session.user.name || "User"}</span>
                                    <span className="text-[0.7rem] text-content-tertiary">{session.user.email}</span>
                                </div>
                                <button
                                    onClick={() => signOut()}
                                    className="py-1.5 px-4 rounded-full text-[0.8rem] font-medium bg-surface-tertiary text-content-secondary border border-border-default cursor-pointer transition-all duration-200 hover:bg-red-600 hover:border-red-600 hover:text-white"
                                >
                                    Sign Out
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleDemoLogin}
                                    disabled={demoLoading}
                                    title="Quick demo: sign in as recruiter John Doe"
                                    aria-label="Quick demo login as recruiter"
                                    className="group inline-flex items-center justify-center w-9 h-9 rounded-full text-content-secondary border border-border-default bg-surface-tertiary cursor-pointer transition-all duration-200 hover:text-warning-400 hover:border-warning-400 hover:shadow-glow disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={demoLoading ? "animate-pulse-custom" : "transition-transform duration-200 group-hover:scale-110"}>
                                        <path d="M9 18h6" />
                                        <path d="M10 22h4" />
                                        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                                    </svg>
                                </button>
                                <Link href="/login" className="inline-flex items-center py-2 px-5 rounded-full text-sm font-medium no-underline text-content-secondary transition-all duration-200 hover:text-content-primary">Log In</Link>
                                <Link href="/register" className="inline-flex items-center py-2 px-6 rounded-full text-sm font-semibold no-underline text-white bg-[image:var(--gradient-primary)] transition-all duration-300 shadow-glow hover:-translate-y-px hover:shadow-glow-strong">Get Started</Link>
                            </div>
                        )}
                    </div>
                </div>

                {/* Mobile Menu Button */}
                <button
                    className="md:hidden bg-transparent border-none text-content-primary cursor-pointer p-2"
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    aria-label="Toggle menu"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        {mobileMenuOpen ? (
                            <>
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </>
                        ) : (
                            <>
                                <line x1="3" y1="6" x2="21" y2="6" />
                                <line x1="3" y1="12" x2="21" y2="12" />
                                <line x1="3" y1="18" x2="21" y2="18" />
                            </>
                        )}
                    </svg>
                </button>
            </div>

            {/* Mobile Menu */}
            {mobileMenuOpen && (
                <div className="mobile-menu-glass flex flex-col gap-1 px-6 pb-6 pt-4 border-t border-border-default bg-[rgba(10,10,15,0.95)]">
                    {session?.user ? (
                        (session.user as any).role === "RECRUITER" ? (
                            <>
                                <Link href="/dashboard" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Dashboard</Link>
                                <Link href="/profile" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>My Profile</Link>
                            </>
                        ) : (
                            <>
                                <Link href="/jobs" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Explore Jobs</Link>
                                <Link href="/profile" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>My Profile</Link>
                            </>
                        )
                    ) : (
                        <>
                            <a href="/#features" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Features</a>
                            <a href="/#how-it-works" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
                            <a href="/#pricing" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
                        </>
                    )}
                    <div className="py-2"><ThemeToggle /></div>
                    <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-border-default">
                        {session?.user ? (
                            <>
                                <div className="flex items-center gap-3 text-content-primary font-medium">
                                    <div className="w-9 h-9 rounded-full bg-[image:var(--gradient-primary)] flex items-center justify-center font-semibold text-sm text-white shrink-0">
                                        {session.user.name?.charAt(0).toUpperCase() || "U"}
                                    </div>
                                    <span>{session.user.name || session.user.email}</span>
                                </div>
                                <button
                                    onClick={() => signOut()}
                                    className="text-center justify-center w-full py-1.5 px-4 rounded-full text-[0.8rem] font-medium bg-surface-tertiary text-content-secondary border border-border-default cursor-pointer transition-all duration-200 hover:bg-red-600 hover:border-red-600 hover:text-white"
                                >
                                    Sign Out
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    onClick={() => { setMobileMenuOpen(false); handleDemoLogin(); }}
                                    disabled={demoLoading}
                                    className="text-center justify-center w-full inline-flex items-center gap-2 py-2 px-5 rounded-full text-sm font-medium text-content-secondary border border-border-default bg-surface-tertiary cursor-pointer transition-all duration-200 hover:text-warning-400 hover:border-warning-400 disabled:opacity-60"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M9 18h6" />
                                        <path d="M10 22h4" />
                                        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                                    </svg>
                                    {demoLoading ? "Signing in..." : "Try demo (recruiter)"}
                                </button>
                                <Link href="/login" className="text-center justify-center w-full inline-flex items-center py-2 px-5 rounded-full text-sm font-medium no-underline text-content-secondary transition-all duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Log In</Link>
                                <Link href="/register" className="text-center justify-center w-full inline-flex items-center py-2 px-6 rounded-full text-sm font-semibold no-underline text-white bg-[image:var(--gradient-primary)] transition-all duration-300 shadow-glow hover:-translate-y-px hover:shadow-glow-strong" onClick={() => setMobileMenuOpen(false)}>Get Started</Link>
                            </>
                        )}
                    </div>
                </div>
            )}
        </nav>
    );
}
