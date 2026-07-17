"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/* ────────── Animated Counter Hook ────────── */
function useAnimatedCounter(target: number, duration: number = 2000, suffix: string = "") {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setStarted(true); obs.disconnect(); } },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    let start = 0;
    const step = target / (duration / 16);
    const id = setInterval(() => {
      start += step;
      if (start >= target) { setCount(target); clearInterval(id); }
      else setCount(Math.floor(start));
    }, 16);
    return () => clearInterval(id);
  }, [started, target, duration]);

  return { ref, display: `${count.toLocaleString()}${suffix}` };
}

/* ────────── Particle Canvas ────────── */
function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let w = 0, h = 0;

    interface Particle {
      x: number; y: number; vx: number; vy: number;
      r: number; color: string; alpha: number;
    }

    const particles: Particle[] = [];
    const colors = [
      "139, 92, 246",   // brand-500
      "124, 58, 237",   // brand-600
      "56, 189, 248",   // accent-400
      "52, 211, 153",   // emerald-400
      "167, 139, 250",  // brand-400
    ];

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      w = canvas!.parentElement?.clientWidth || window.innerWidth;
      h = canvas!.parentElement?.clientHeight || window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.scale(dpr, dpr);
    }

    function isMobile() { return window.innerWidth < 768; }

    function init() {
      resize();
      particles.length = 0;
      const count = isMobile() ? 40 : 80;
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          r: Math.random() * 2 + 0.5,
          color: colors[Math.floor(Math.random() * colors.length)],
          alpha: Math.random() * 0.5 + 0.2,
        });
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      const connectionDist = isMobile() ? 100 : 150;

      // Draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectionDist) {
            const opacity = (1 - dist / connectionDist) * 0.15;
            ctx!.beginPath();
            ctx!.strokeStyle = `rgba(${particles[i].color}, ${opacity})`;
            ctx!.lineWidth = 0.5;
            ctx!.moveTo(particles[i].x, particles[i].y);
            ctx!.lineTo(particles[j].x, particles[j].y);
            ctx!.stroke();
          }
        }
      }

      // Draw particles
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${p.color}, ${p.alpha})`;
        ctx!.fill();

        // Glow
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
        const grad = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        grad.addColorStop(0, `rgba(${p.color}, ${p.alpha * 0.3})`);
        grad.addColorStop(1, `rgba(${p.color}, 0)`);
        ctx!.fillStyle = grad;
        ctx!.fill();
      }

      animId = requestAnimationFrame(draw);
    }

    init();
    draw();
    window.addEventListener("resize", init);
    return () => { cancelAnimationFrame(animId); window.removeEventListener("resize", init); };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full z-0"
      style={{ pointerEvents: "none" }}
    />
  );
}

/* ────────── CheckIcon ────────── */
function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* ────────── Badge Pill ────────── */
function HeroBadge() {
  return (
    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 backdrop-blur-sm mb-8 hero-badge-enter">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success-400" />
      </span>
      <span className="text-sm font-medium text-brand-300 tracking-wide font-display">AI-Powered Agentic Recruitment</span>
    </div>
  );
}

/* ────────── HOME PAGE ────────── */
export default function HomePage() {
  const stat1 = useAnimatedCounter(1200, 2000, "+");
  const stat2 = useAnimatedCounter(80, 2200, "%");
  const stat3 = useAnimatedCounter(15, 1800, "ms");

  return (
    <div className="bg-surface-primary text-content-primary min-h-screen font-sans selection:bg-brand-500/30">
      {/* ===== HERO ===== */}
      <section className="relative min-h-screen flex items-center justify-center pt-20 pb-20 px-6 overflow-hidden" id="hero">

        {/* ── Layer 1: Animated particle constellation ── */}
        <ParticleCanvas />

        {/* ── Layer 2: Gradient orbs ── */}
        <div className="absolute inset-0 z-[1] overflow-hidden pointer-events-none">
          {/* Top-left orb */}
          <div className="absolute -top-[15%] -left-[10%] w-[350px] md:w-[550px] h-[350px] md:h-[550px] rounded-full bg-brand-600/25 blur-[120px] hero-orb-1" />
          {/* Bottom-right orb */}
          <div className="absolute -bottom-[15%] -right-[10%] w-[300px] md:w-[500px] h-[300px] md:h-[500px] rounded-full bg-accent-500/20 blur-[120px] hero-orb-2" />
          {/* Center glow */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] md:w-[800px] h-[500px] md:h-[800px] rounded-full bg-brand-700/10 blur-[150px] hero-orb-3" />
        </div>

        {/* ── Layer 3: Grid overlay ── */}
        <div className="absolute inset-0 z-[2] hero-grid-pattern pointer-events-none" />

        {/* ── Layer 4: Floating glassmorphism elements ── */}
        <div className="absolute inset-0 z-[3] pointer-events-none hidden md:block">
          {/* Floating card 1 */}
          <div className="absolute top-[18%] left-[8%] w-14 h-14 rounded-xl bg-brand-500/10 border border-brand-500/20 backdrop-blur-md flex items-center justify-center animate-float hero-float-enter-1">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(167,139,250,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          </div>
          {/* Floating card 2 */}
          <div className="absolute top-[25%] right-[10%] w-12 h-12 rounded-lg bg-accent-500/10 border border-accent-500/20 backdrop-blur-md flex items-center justify-center animate-float-reverse hero-float-enter-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </div>
          {/* Floating card 3 */}
          <div className="absolute bottom-[22%] left-[12%] w-10 h-10 rounded-lg bg-success-400/10 border border-success-400/20 backdrop-blur-md flex items-center justify-center animate-float-slow hero-float-enter-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(52,211,153,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
          </div>
          {/* Floating card 4 */}
          <div className="absolute bottom-[28%] right-[8%] w-16 h-16 rounded-2xl bg-brand-600/8 border border-brand-400/15 backdrop-blur-md flex items-center justify-center animate-float hero-float-enter-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(139,92,246,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          </div>
          {/* Small dot accents */}
          <div className="absolute top-[40%] left-[22%] w-2 h-2 rounded-full bg-brand-400/40 animate-pulse" />
          <div className="absolute top-[60%] right-[20%] w-1.5 h-1.5 rounded-full bg-accent-400/40 animate-pulse" style={{ animationDelay: "1s" }} />
          <div className="absolute top-[30%] left-[40%] w-1 h-1 rounded-full bg-success-400/50 animate-pulse" style={{ animationDelay: "0.5s" }} />
        </div>

        {/* ── Hero Content ── */}
        <div className="relative z-10 text-center max-w-4xl mx-auto">

          {/* Badge */}
          <HeroBadge />

          {/* Headline */}
          <h1 className="text-4xl sm:text-5xl md:text-7xl lg:text-[5.5rem] font-extrabold leading-[1.05] tracking-tight mb-6 hero-heading-enter font-display">
            Find the Best <br />
            <span className="gradient-text hero-gradient-shimmer">
              Candidates instantly
            </span>
          </h1>

          {/* Subtext */}
          <p className="text-base sm:text-lg md:text-xl text-content-secondary max-w-2xl mx-auto mb-10 leading-relaxed hero-sub-enter font-sans">
            Automate your entire hiring pipeline with agentic AI. 
            LuminaHire screens resumes, matches skills, and conducts outreach 
            so you can focus on interviewing the best talent.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 hero-cta-enter font-sans">
            <Link
              href="/register"
              className="group relative inline-flex items-center gap-2 py-4 px-8 rounded-full text-base font-bold text-white bg-brand-600 hover:bg-brand-500 transition-all duration-300 shadow-lg shadow-brand-500/25 hover:shadow-xl hover:shadow-brand-500/40 hover:-translate-y-1 overflow-hidden"
            >
              {/* Shimmer overlay */}
              <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none" />
              Start Hiring
              <svg className="group-hover:translate-x-1 transition-transform" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Link>
            <Link
              href="#how-it-works"
              className="group inline-flex items-center gap-2 py-4 px-8 rounded-full text-base font-semibold text-content-secondary bg-surface-card/60 border border-border-default backdrop-blur-sm hover:bg-surface-tertiary hover:text-content-primary hover:border-brand-500/30 transition-all duration-300"
            >
              <svg className="text-brand-400 group-hover:scale-110 transition-transform" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              See How It Works
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6 md:gap-10 hero-stats-enter font-sans">
            <div className="relative p-5 rounded-2xl bg-surface-card/40 border border-border-default backdrop-blur-sm hover:border-brand-500/30 transition-all duration-300 group">
              <div ref={stat1.ref} className="text-3xl md:text-4xl font-bold text-content-primary group-hover:text-brand-400 transition-colors">{stat1.display}</div>
              <div className="text-xs md:text-sm text-content-tertiary uppercase tracking-wider mt-1.5 font-medium">Resumes Screened</div>
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 rounded-full bg-brand-500/0 group-hover:bg-brand-500/50 transition-all duration-300" />
            </div>
            <div className="relative p-5 rounded-2xl bg-surface-card/40 border border-border-default backdrop-blur-sm hover:border-accent-500/30 transition-all duration-300 group">
              <div ref={stat2.ref} className="text-3xl md:text-4xl font-bold text-content-primary group-hover:text-accent-400 transition-colors">{stat2.display}</div>
              <div className="text-xs md:text-sm text-content-tertiary uppercase tracking-wider mt-1.5 font-medium">Match Accuracy</div>
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 rounded-full bg-accent-500/0 group-hover:bg-accent-500/50 transition-all duration-300" />
            </div>
            <div className="relative p-5 rounded-2xl bg-surface-card/40 border border-border-default backdrop-blur-sm hover:border-success-400/30 transition-all duration-300 group col-span-2 md:col-span-1">
              <div ref={stat3.ref} className="text-3xl md:text-4xl font-bold text-content-primary group-hover:text-success-400 transition-colors">{stat3.display}</div>
              <div className="text-xs md:text-sm text-content-tertiary uppercase tracking-wider mt-1.5 font-medium">Time to Hire</div>
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-0.5 rounded-full bg-success-400/0 group-hover:bg-success-400/50 transition-all duration-300" />
            </div>
          </div>
        </div>

        {/* Bottom fade */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-surface-primary to-transparent z-[5] pointer-events-none" />
      </section>

      {/* ===== FEATURES ===== */}
      <section className="py-24 px-6" id="features">
        <div className="max-w-6xl mx-auto">
          {/* Section Header */}
          <div className="text-center mb-16">
            <span className="text-brand-400 text-sm font-bold uppercase tracking-[0.2em] mb-4 block font-sans">
              ✦ Features
            </span>
            <h2 className="text-3xl md:text-5xl font-bold mb-6 font-display">
              Hire Smarter <span className="text-brand-400">With Agentic AI</span>
            </h2>
            <p className="text-content-secondary max-w-xl mx-auto text-lg font-sans">
              Finding the right talent is hard. LuminaHire makes it effortless with autonomous AI agents.
            </p>
          </div>

          {/* Feature Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 font-sans">
            {/* Card 1 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-brand-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-brand-500/10 text-brand-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">AI Resume Screening</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                Upload job descriptions. Our AI parses candidate resumes to extract skills and match them perfectly.
              </p>
            </div>

            {/* Card 2 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-accent-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-accent-500/10 text-accent-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Vector Candidate Search</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                Search your candidate pool with natural language. Ask "Who has 5 years of React experience?" and get instant answers.
              </p>
            </div>

            {/* Card 3 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-success-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-success-500/10 text-success-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Automated Outreach</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                Stop writing manual emails. Let our LangGraph agents draft highly personalized outreach to top candidates automatically.
              </p>
            </div>

            {/* Card 4 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-warning-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-warning-500/10 text-warning-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14.5 2 14.5 8 20 8" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Unbiased Scoring</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                AI agents use multi-step reasoning to evaluate candidates fairly, removing human bias from initial screens.
              </p>
            </div>

            {/* Card 5 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-danger-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-danger-500/10 text-danger-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                    <line x1="6" y1="6" x2="6" y2="6.01" />
                    <line x1="6" y1="18" x2="6" y2="18.01" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Continuous Sourcing</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                Our background continuous agents scan for new talent matching your open roles 24/7 without intervention.
              </p>
            </div>

            {/* Card 6 */}
            <div className="group p-8 rounded-2xl bg-surface-card border border-border-default hover:border-brand-500/50 hover:bg-surface-card-hover transition-all duration-300">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-brand-500/10 text-brand-400 group-hover:scale-110 transition-transform">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20v-6M6 20V10M18 20V4" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Hiring Analytics</h3>
              <p className="text-content-secondary leading-relaxed text-sm">
                Understand your hiring pipeline. Identify bottlenecks and source quality before they become issues.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== HOW IT WORKS ===== */}
      <section className="py-24 px-6 bg-surface-secondary/30" id="how-it-works">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <span className="text-accent-400 text-sm font-bold uppercase tracking-[0.2em] mb-4 block font-sans">
              ⚡ How It Works
            </span>
            <h2 className="text-3xl md:text-5xl font-bold mb-6 text-content-primary font-display">
              Three Steps to Top <span className="text-accent-400">Talent</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative font-sans">
            <div className="relative text-center group">
              <div className="w-16 h-16 rounded-full bg-brand-600 flex items-center justify-center text-2xl font-bold text-white mx-auto mb-6 shadow-xl shadow-brand-500/20 relative z-10">1</div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Post a Job</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Upload a job description. No formal structure needed. Just plain English or markdown.
              </p>
            </div>

            <div className="relative text-center group">
              <div className="w-16 h-16 rounded-full bg-brand-600 flex items-center justify-center text-2xl font-bold text-white mx-auto mb-6 shadow-xl shadow-brand-500/20 relative z-10">2</div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Agents Screen Resumes</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Our LangGraph agents parse candidate resumes, score them against requirements, and filter the best matches.
              </p>
            </div>

            <div className="relative text-center group">
              <div className="w-16 h-16 rounded-full bg-brand-600 flex items-center justify-center text-2xl font-bold text-white mx-auto mb-6 shadow-xl shadow-brand-500/20 relative z-10">3</div>
              <h3 className="text-xl font-bold mb-3 text-content-primary font-display">Interview Top Matches</h3>
              <p className="text-content-secondary text-sm leading-relaxed">
                Access a ranked list of top candidates. Review AI reasoning and click approve to start interviewing.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== PRICING ===== */}
      <section className="py-24 px-6" id="pricing">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <span className="text-brand-400 text-sm font-bold uppercase tracking-[0.2em] mb-4 block font-sans">
              💎 Pricing
            </span>
            <h2 className="text-3xl md:text-5xl font-bold mb-6 text-content-primary font-display">
              Plans for Every <span className="text-brand-400">Team Size</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-5xl mx-auto items-center font-sans">
            {/* Starter */}
            <div className="p-8 rounded-2xl bg-surface-card border border-border-default hover:border-border-hover transition-all">
              <div className="text-lg font-semibold mb-4 text-content-secondary font-display">Starter</div>
              <div className="text-4xl font-bold mb-6 text-content-primary">$0<span className="text-lg font-normal text-content-tertiary">/mo</span></div>
              <ul className="space-y-4 mb-8">
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> Unlimited Job Posts</li>
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> Basic AI Screening</li>
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> Up to 50 Candidates/mo</li>
              </ul>
              <Link href="/register" className="block w-full py-3 rounded-xl text-center font-bold border border-border-default text-content-primary hover:bg-surface-tertiary transition-colors">
                Get Started
              </Link>
            </div>

            {/* Professional — Featured */}
            <div className="p-8 rounded-2xl bg-brand-600 border-2 border-brand-400 shadow-2xl shadow-brand-500/20 transform lg:scale-110 z-10">
              <div className="text-lg font-semibold mb-4 text-brand-100 font-display">Pro Recruiter</div>
              <div className="text-4xl font-bold mb-6 text-white">$29<span className="text-lg font-normal text-brand-200">/mo</span></div>
              <ul className="space-y-4 mb-8">
                <li className="flex items-center gap-3 text-sm text-white"><CheckIcon /> Everything in Starter</li>
                <li className="flex items-center gap-3 text-sm text-white"><CheckIcon /> Unlimited Candidates</li>
                <li className="flex items-center gap-3 text-sm text-white"><CheckIcon /> Agentic Automated Outreach</li>
                <li className="flex items-center gap-3 text-sm text-white"><CheckIcon /> Advanced Analytics</li>
              </ul>
              <Link href="/register" className="block w-full py-3 rounded-xl text-center font-bold bg-white text-brand-600 hover:bg-brand-50 transition-colors">
                Start Free Trial
              </Link>
            </div>

            {/* Enterprise */}
            <div className="p-8 rounded-2xl bg-surface-card border border-border-default hover:border-border-hover transition-all">
              <div className="text-lg font-semibold mb-4 text-content-secondary font-display">Enterprise</div>
              <div className="text-4xl font-bold mb-6 text-content-primary">$99<span className="text-lg font-normal text-content-tertiary">/mo</span></div>
              <ul className="space-y-4 mb-8">
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> Everything in Pro</li>
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> Custom Screening Rules</li>
                <li className="flex items-center gap-3 text-sm text-content-secondary"><CheckIcon /> ATS Integrations</li>
              </ul>
              <Link href="/register" className="block w-full py-3 rounded-xl text-center font-bold border border-border-default text-content-primary hover:bg-surface-tertiary transition-colors">
                Contact Sales
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="py-24 px-6 relative overflow-hidden bg-brand-900/20">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-full bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.15),transparent_70%)]" />
        <div className="text-center relative z-10 max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold mb-6 text-content-primary font-display">
            Ready to Build Better <span className="text-brand-400">Teams</span>?
          </h2>
          <p className="text-content-secondary text-lg mb-10 font-sans">
            Join forward-thinking companies that prioritize speed and quality of hire with LuminaHire.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 py-4 px-10 rounded-full text-lg font-bold text-white bg-brand-600 hover:bg-brand-500 transition-all shadow-xl shadow-brand-500/20 hover:-translate-y-1 font-sans"
          >
            Post Your First Job
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
        </div>
      </section>
    </div>
  );
}