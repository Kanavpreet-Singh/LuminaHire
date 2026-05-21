"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";

export default function Navbar() {
    const { data: session, status } = useSession();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    return (
        <nav className="navbar-glass fixed top-0 left-0 right-0 z-[1000] bg-[rgba(10,10,15,0.8)] backdrop-blur-[20px] border-b border-border-default transition-all duration-300">
            <div className="max-w-[1280px] mx-auto px-6 h-[72px] flex items-center justify-between">
                {/* Logo */}
                <Link href="/" className="flex items-center gap-2.5 no-underline text-content-primary font-bold text-xl">
                    <div className="flex items-center justify-center w-10 h-10 rounded-md bg-[image:var(--gradient-primary)] text-white">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </div>
                    <span className="gradient-text text-[1.375rem] tracking-[-0.02em] font-bold">StackMemo</span>
                </Link>

                {/* Desktop Navigation */}
                <div className="hidden md:flex gap-8">
                    {session?.user ? (
                        <>
                            <Link href="/dashboard/companies" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">My Companies</Link>
                            <Link href="/companies" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">All Companies</Link>
                        </>
                    ) : (
                        <>
                            <Link href="/#features" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Features</Link>
                            <Link href="/#how-it-works" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">How It Works</Link>
                            <Link href="/#pricing" className="nav-link-underline relative no-underline text-content-secondary text-[0.9rem] font-medium transition-colors duration-200 hover:text-content-primary">Pricing</Link>
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
                        <>
                            <Link href="/dashboard/companies" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>My Companies</Link>
                            <Link href="/companies" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>All Companies</Link>
                        </>
                    ) : (
                        <>
                            <Link href="/#features" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Features</Link>
                            <Link href="/#how-it-works" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>How It Works</Link>
                            <Link href="/#pricing" className="no-underline text-content-secondary py-3 text-[0.95rem] font-medium transition-colors duration-200 hover:text-content-primary" onClick={() => setMobileMenuOpen(false)}>Pricing</Link>
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
