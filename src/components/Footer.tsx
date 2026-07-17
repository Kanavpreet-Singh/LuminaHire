import Link from "next/link";

export default function Footer() {
    return (
        <footer className="pt-16 px-6 pb-8 border-t border-border-default bg-surface-primary">
            <div className="max-w-[1200px] mx-auto">
                {/* Footer Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr] gap-8 lg:gap-12 mb-12">
                    {/* Brand Column */}
                    <div>
                        <div className="flex items-center gap-2 mb-4">
                            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-[image:var(--gradient-primary)] text-white">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                </svg>
                            </div>
                            <span className="gradient-text text-[1.375rem] tracking-[-0.02em] font-bold">LuminaHire</span>
                        </div>
                        <p className="text-[0.85rem] text-content-tertiary leading-relaxed max-w-[320px]">
                            AI-powered recruitment platform. Automate your hiring pipeline with agentic AI and find the best talent faster.
                        </p>
                    </div>

                    {/* Product Column */}
                    <div>
                        <h4 className="text-[0.85rem] font-semibold text-content-primary uppercase tracking-[0.08em] mb-4">Product</h4>
                        <ul className="list-none flex flex-col gap-2.5">
                            <li><a href="/#features" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Features</a></li>
                            <li><a href="/#pricing" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Pricing</a></li>
                            <li><a href="/#how-it-works" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">How It Works</a></li>
                        </ul>
                    </div>

                    {/* Company Column */}
                    <div>
                        <h4 className="text-[0.85rem] font-semibold text-content-primary uppercase tracking-[0.08em] mb-4">Company</h4>
                        <ul className="list-none flex flex-col gap-2.5">
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">About</a></li>
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Blog</a></li>
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Careers</a></li>
                        </ul>
                    </div>

                    {/* Legal Column */}
                    <div>
                        <h4 className="text-[0.85rem] font-semibold text-content-primary uppercase tracking-[0.08em] mb-4">Legal</h4>
                        <ul className="list-none flex flex-col gap-2.5">
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Privacy</a></li>
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Terms</a></li>
                            <li><a href="#" className="text-[0.85rem] text-content-tertiary no-underline transition-colors duration-200 hover:text-content-primary">Cookie Policy</a></li>
                        </ul>
                    </div>
                </div>

                {/* Bottom Bar */}
                <div className="flex flex-col md:flex-row items-center justify-between pt-8 border-t border-border-default text-[0.8rem] text-content-tertiary gap-4 text-center md:text-left">
                    <p>&copy; {new Date().getFullYear()} LuminaHire. All rights reserved.</p>
                    <div className="flex gap-4">
                        <a href="#" aria-label="Twitter" className="text-content-tertiary transition-colors duration-200 hover:text-content-primary">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                            </svg>
                        </a>
                        <a href="#" aria-label="GitHub" className="text-content-tertiary transition-colors duration-200 hover:text-content-primary">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                            </svg>
                        </a>
                        <a href="#" aria-label="LinkedIn" className="text-content-tertiary transition-colors duration-200 hover:text-content-primary">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                            </svg>
                        </a>
                    </div>
                </div>
            </div>
        </footer>
    );
}
