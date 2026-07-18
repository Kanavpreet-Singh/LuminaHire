"use client";

import { useEffect, useRef, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface SearchQuery {
    heading: string;
    explanation: string;
    source: string;
    search_queries: string[];
}

interface ResearchFinding {
    heading: string;
    query?: string;
    source: string;
    findings: string;
    status: string;
    urls?: ({ url: string; title?: string } | string)[];
    iteration?: number;
    triggered_by?: string;
}

interface EvidenceItem {
    claim: string;
    source_url: string;
    source_type: string;
}

interface EvaluationData {
    dimension_scores?: {
        skills?: number;
        experience?: number;
        project_complexity?: number;
        education?: number;
        public_work?: number;
    };
    overall_fit_percentage?: number;
    verified_skills?: string[];
    gaps_or_concerns?: string[];
    evidence?: EvidenceItem[];
    evidence_sufficient?: boolean;
}

interface QAEntry {
    question: string;
    answer: string;
    citations?: string[];
    askedAt: string;
}

interface VettingSessionData {
    id: string;
    status: string;
    researchPlan: {
        target_candidate: string;
        core_skills_to_verify: string[];
        research_plan: SearchQuery[];
        company_vetting: {
            companies: string[];
            questions: string[];
        };
    } | null;
    researchResults: ResearchFinding[] | any;
    evaluation: EvaluationData | null;
    qaHistory: QAEntry[] | null;
    finalReport: {
        overall_fit_percentage: number;
        summary: string;
        verified_skills: string[];
        gaps_or_concerns: string[];
        interview_questions: string[];
        verdict: string;
        // Multi-agent committee extensions (optional; older sessions won't have them)
        dimension_scores?: {
            skills?: number;
            experience?: number;
            project_complexity?: number;
            education?: number;
            public_work?: number;
        };
        evidence?: { claim: string; source_url: string; source_type: string }[];
        red_flags?: string[];
        narrative?: string;
        hiring_recommendation?: string;
        research_iterations?: number;
    } | null;
    logs: string[];
    application: {
        candidate: {
            id: string;
            name: string;
            email: string;
            phone: string | null;
            linkedinUrl: string | null;
            githubUrl: string | null;
        };
        job: {
            id: string;
            title: string;
            description: string;
            requirements: string | null;
        };
    };
}

export default function VettingSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
    const router = useRouter();
    const { sessionId } = use(params);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [restartError, setRestartError] = useState("");
    const [resuming, setResuming] = useState(false);
    const [error, setError] = useState("");
    const [sessionData, setSessionData] = useState<VettingSessionData | null>(null);
    const stepFeedContainerRef = useRef<HTMLDivElement | null>(null);

    // Edit states for the plan
    const [queries, setQueries] = useState<SearchQuery[]>([]);
    const [coreSkills, setCoreSkills] = useState<string[]>([]);
    const [companyVettingQuestions, setCompanyVettingQuestions] = useState<string[]>([]);
    const [expandedQueryIndex, setExpandedQueryIndex] = useState<number | null>(null);

    // Research review (AWAITING_RESEARCH_INPUT) HITL state
    const [followupText, setFollowupText] = useState("");
    const [submittingFollowup, setSubmittingFollowup] = useState(false);
    const [lastToolCalls, setLastToolCalls] = useState<{ tool: string; args: any }[]>([]);
    const [approvingResearch, setApprovingResearch] = useState(false);

    // Evaluation review (AWAITING_EVALUATION_APPROVAL) HITL state
    const [approvingEvaluation, setApprovingEvaluation] = useState(false);
    const [requestingMoreResearch, setRequestingMoreResearch] = useState(false);
    // Local-only flag: set the instant "Approve Evaluation" is clicked so the
    // running-spinner view can show report-writing copy even though both the
    // evaluate and report-write stages share DB status EVALUATING.
    const [generatingReport, setGeneratingReport] = useState(false);

    // Q&A (COMPLETED view) state
    const [qaQuestion, setQaQuestion] = useState("");
    const [askingQuestion, setAskingQuestion] = useState(false);

    // Completed-view stage inspector: which pipeline stage's stored output is
    // shown. Every stage's data is persisted on the session (researchPlan,
    // researchResults, evaluation, finalReport), so a completed session can be
    // reviewed stage by stage at any time.
    const [completedTab, setCompletedTab] = useState<"plan" | "research" | "evaluation" | "report">("report");

    useEffect(() => {
        fetchSession();
    }, [sessionId]);

    // Poll while a background run is in flight so the step feed advances live.
    // 1.5s (not the previous 4s) so individual agent tool-call steps -- which
    // the backend now emits one at a time as they happen, not just once per
    // whole stage -- show up close to as they occur.
    useEffect(() => {
        const status = sessionData?.status;
        if (status !== "RESEARCHING" && status !== "EVALUATING") return;
        const interval = setInterval(() => {
            refreshSession();
        }, 1500);
        return () => clearInterval(interval);
    }, [sessionData?.status]);

    // Auto-scroll the live step feed to the newest line as it grows. Scrolls
    // only this panel's own scrollTop (never scrollIntoView, which walks up
    // every scrollable ancestor -- including the whole page -- and yanks the
    // user's page-scroll position around on every poll). Also only auto-
    // scrolls when the user is already near the bottom, so scrolling up to
    // read earlier lines doesn't get fought on the next update.
    useEffect(() => {
        if (sessionData?.status !== "RESEARCHING" && sessionData?.status !== "EVALUATING") return;
        const el = stepFeedContainerRef.current;
        if (!el) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }, [sessionData?.logs, sessionData?.status]);

    const applyPlanFromSession = (vs: VettingSessionData) => {
        if (vs.researchPlan) {
            setQueries(vs.researchPlan.research_plan || []);
            setCoreSkills(vs.researchPlan.core_skills_to_verify || []);
            setCompanyVettingQuestions(vs.researchPlan.company_vetting?.questions || []);
        }
    };

    const fetchSession = async () => {
        try {
            setLoading(true);
            setError("");
            const res = await fetch(`/api/vet/session/${sessionId}`);
            if (!res.ok) {
                throw new Error("Failed to load recruit session details");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
            applyPlanFromSession(data.vettingSession);
        } catch (err: any) {
            setError(err.message || "An error occurred");
        } finally {
            setLoading(false);
        }
    };

    // Silent refresh (no loading spinner) used by the polling loop.
    const refreshSession = async () => {
        try {
            const res = await fetch(`/api/vet/session/${sessionId}`, { cache: "no-store" });
            if (!res.ok) return;
            const data = await res.json();
            setSessionData(data.vettingSession);
            // Backfill the plan once a committee run's planner completes.
            if (data.vettingSession.researchPlan && queries.length === 0) {
                applyPlanFromSession(data.vettingSession);
            }
        } catch {
            /* transient; next tick retries */
        }
    };

    const handleSavePlan = async (silent = false) => {
        if (!sessionData) return;
        setSaving(true);
        try {
            const updatedPlan = {
                ...sessionData.researchPlan,
                core_skills_to_verify: coreSkills,
                research_plan: queries,
                company_vetting: {
                    companies: sessionData.researchPlan?.company_vetting?.companies || [],
                    questions: companyVettingQuestions
                }
            };

            const res = await fetch(`/api/vet/session/${sessionId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ researchPlan: updatedPlan })
            });

            if (!res.ok) {
                throw new Error(await res.text() || "Failed to save changes");
            }

            if (!silent) {
                alert("Research plan changes saved successfully!");
            }
        } catch (err: any) {
            alert("Error saving changes: " + err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleExecuteVetting = async () => {
        if (!sessionData) return;
        
        // Save the plan changes first
        await handleSavePlan(true);

        setExecuting(true);
        setError("");
        
        // Optimistically update status to show loading indicator
        setSessionData(prev => prev ? { ...prev, status: "RESEARCHING" } : null);

        try {
            const res = await fetch(`/api/vet/session/${sessionId}/execute`, {
                method: "POST"
            });

            if (!res.ok) {
                throw new Error(await res.text() || "Recruit execution failed");
            }

            const data = await res.json();
            setSessionData(data.vettingSession);
        } catch (err: any) {
            setError(err.message || "Execution failed. Please try again.");
            fetchSession(); // reload last saved state
        } finally {
            setExecuting(false);
        }
    };

    const handleResumeSession = async () => {
        setResuming(true);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/resume`, { method: "POST" });
            if (!res.ok) {
                throw new Error((await res.text()) || "Failed to resume session");
            }
            const data = await res.json();
            setSessionData(data.vettingSession); // now RESEARCHING/EVALUATING -> polling resumes
        } catch (err: any) {
            alert(err.message || "Could not resume the session.");
        } finally {
            setResuming(false);
        }
    };

    const handleSubmitFollowup = async () => {
        if (!followupText.trim()) return;
        setSubmittingFollowup(true);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/research/followup`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ instruction: followupText.trim() }),
            });
            if (!res.ok) {
                throw new Error((await res.text()) || "Guided research failed");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
            setLastToolCalls(data.toolCalls || []);
            setFollowupText("");
        } catch (err: any) {
            alert(err.message || "Could not run guided research.");
        } finally {
            setSubmittingFollowup(false);
        }
    };

    const handleApproveResearch = async () => {
        setApprovingResearch(true);
        setSessionData(prev => prev ? { ...prev, status: "EVALUATING" } : null);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/research/approve`, { method: "POST" });
            if (!res.ok) {
                throw new Error((await res.text()) || "Failed to approve research");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
        } catch (err: any) {
            alert(err.message || "Could not approve research.");
            fetchSession();
        } finally {
            setApprovingResearch(false);
        }
    };

    const handleApproveEvaluation = async () => {
        setApprovingEvaluation(true);
        setGeneratingReport(true);
        setSessionData(prev => prev ? { ...prev, status: "EVALUATING" } : null);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/evaluation/approve`, { method: "POST" });
            if (!res.ok) {
                throw new Error((await res.text()) || "Failed to approve evaluation");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
        } catch (err: any) {
            alert(err.message || "Could not approve evaluation.");
            setGeneratingReport(false);
            fetchSession();
        } finally {
            setApprovingEvaluation(false);
        }
    };

    const handleRequestMoreResearch = async () => {
        setRequestingMoreResearch(true);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/evaluation/request-more-research`, { method: "POST" });
            if (!res.ok) {
                throw new Error((await res.text()) || "Failed to request more research");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
        } catch (err: any) {
            alert(err.message || "Could not send back for more research.");
        } finally {
            setRequestingMoreResearch(false);
        }
    };

    const handleAskQuestion = async () => {
        if (!qaQuestion.trim()) return;
        setAskingQuestion(true);
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/qa`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: qaQuestion.trim() }),
            });
            if (!res.ok) {
                throw new Error((await res.text()) || "Failed to get an answer");
            }
            const data = await res.json();
            setSessionData(data.vettingSession);
            setQaQuestion("");
        } catch (err: any) {
            alert(err.message || "Could not answer the question.");
        } finally {
            setAskingQuestion(false);
        }
    };

    const handleRestartSession = async () => {
        if (!confirm("Are you sure you want to restart this session? This will re-run the Planner LLM and discard the current plan and results.")) {
            return;
        }

        setRestarting(true);
        setRestartError("");
        
        try {
            const res = await fetch(`/api/vet/session/${sessionId}/restart`, {
                method: "POST"
            });

            if (!res.ok) {
                throw new Error(await res.text() || "Failed to restart session");
            }

            const data = await res.json();
            setSessionData(data.vettingSession);
            if (data.vettingSession.researchPlan) {
                setQueries(data.vettingSession.researchPlan.research_plan || []);
                setCoreSkills(data.vettingSession.researchPlan.core_skills_to_verify || []);
                setCompanyVettingQuestions(data.vettingSession.researchPlan.company_vetting?.questions || []);
            }
            setExpandedQueryIndex(null);
            setRestarting(false);
        } catch (err: any) {
            setRestarting(false);
            setRestartError(err.message || "Restart failed.");
        }
    };

    // Plan editing utilities
    const handleUpdateQueryField = (index: number, field: keyof SearchQuery, value: any) => {
        setQueries(prev => prev.map((q, idx) => idx === index ? { ...q, [field]: value } : q));
    };

    const handleUpdateSearchQueries = (index: number, valString: string) => {
        const list = valString.split(",").map(s => s.trim()).filter(Boolean);
        handleUpdateQueryField(index, "search_queries", list);
    };

    const handleDeleteQuery = (index: number) => {
        setQueries(prev => prev.filter((_, idx) => idx !== index));
        if (expandedQueryIndex === index) {
            setExpandedQueryIndex(null);
        }
    };

    const handleAddQuery = () => {
        setQueries(prev => [
            ...prev,
            {
                heading: "New Research Objective",
                explanation: "",
                source: "WEB_SEARCH",
                search_queries: []
            }
        ]);
        setExpandedQueryIndex(queries.length); // auto-expand new query
    };

    const handleAddSkill = (skill: string) => {
        if (skill.trim() && !coreSkills.includes(skill.trim())) {
            setCoreSkills(prev => [...prev, skill.trim()]);
        }
    };

    const handleRemoveSkill = (index: number) => {
        setCoreSkills(prev => prev.filter((_, idx) => idx !== index));
    };

    const handleAddCompanyQuestion = (question: string) => {
        if (question.trim() && !companyVettingQuestions.includes(question.trim())) {
            setCompanyVettingQuestions(prev => [...prev, question.trim()]);
        }
    };

    const handleRemoveCompanyQuestion = (index: number) => {
        setCompanyVettingQuestions(prev => prev.filter((_, idx) => idx !== index));
    };

    if (loading) {
        return (
            <div className="flex-1 bg-surface-primary flex flex-col justify-center items-center p-8 space-y-4">
                <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-content-secondary font-bold text-lg">Retrieving Recruit Session...</span>
            </div>
        );
    }

    if (error && !sessionData) {
        return (
            <div className="flex-1 bg-surface-primary flex flex-col justify-center items-center p-8 space-y-4">
                <div className="p-6 bg-rose-500/10 border border-rose-500/20 text-rose-600 rounded-2xl text-center max-w-md">
                    <h2 className="text-xl font-bold mb-2">Error Loading Session</h2>
                    <p className="text-sm">{error}</p>
                </div>
                <Link href="/vetting" className="px-5 py-2.5 bg-surface-tertiary border border-border-default rounded-xl font-bold text-sm text-content-secondary hover:bg-surface-secondary">
                    Back to Sessions
                </Link>
            </div>
        );
    }

    if (!sessionData) return null;

    if (!sessionData.application) {
        return (
            <div className="flex-1 bg-surface-primary flex flex-col justify-center items-center p-8 space-y-4">
                <div className="p-6 bg-amber-500/10 border border-amber-500/20 text-amber-700 rounded-2xl text-center max-w-md">
                    <h2 className="text-xl font-bold mb-2">Session Data Incomplete</h2>
                    <p className="text-sm">The session is still loading related candidate and job details. Try refreshing in a moment.</p>
                </div>
                <button
                    onClick={fetchSession}
                    className="px-5 py-2.5 bg-surface-tertiary border border-border-default rounded-xl font-bold text-sm text-content-secondary hover:bg-surface-secondary"
                >
                    Refresh Session
                </button>
            </div>
        );
    }

    const { candidate, job } = sessionData.application;
    const isPlanning = sessionData.status === "PLANNING";
    const isResearching = sessionData.status === "RESEARCHING" || executing;
    const isEvaluating = sessionData.status === "EVALUATING";
    const isAwaitingResearch = sessionData.status === "AWAITING_RESEARCH_INPUT";
    const isAwaitingEvaluation = sessionData.status === "AWAITING_EVALUATION_APPROVAL";
    const isRunning = isResearching || isEvaluating;
    const isCompleted = sessionData.status === "COMPLETED";
    const isFailed = sessionData.status === "FAILED";

    const getTimelineStep = () => {
        if (isCompleted) return 4;
        if (isEvaluating || isAwaitingEvaluation) return 3;
        if (isResearching || isAwaitingResearch) return 2;
        return 1; // planning / default
    };

    const currentStep = getTimelineStep();
    const primaryActionLabel = isPlanning
        ? "Approve Planner & Start Research"
        : isResearching
        ? "Approve Research & Move to Evaluation"
        : isEvaluating
        ? "Approve Evaluation & Generate Report"
        : "Workflow Complete";
    const primaryActionDisabled = saving || executing || isCompleted;

    return (
        <div className="flex-1 bg-surface-primary py-8 sm:py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-5xl mx-auto space-y-8">
                {/* Command Center */}
                <div className="grid grid-cols-1 gap-6">
                    <div className="rounded-[2rem] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.18),transparent_38%),linear-gradient(180deg,rgba(18,18,28,0.96),rgba(14,14,20,0.98))] shadow-[0_28px_80px_rgba(0,0,0,0.45)] p-6 sm:p-8">
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-5">
                            <div className="space-y-3">
                                <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white">
                                    Recruiting <span className="gradient-text">{candidate.name}</span>
                                </h1>
                                <p className="text-sm sm:text-base text-content-secondary max-w-2xl leading-relaxed">
                                    Applying for <span className="text-white font-bold">{job.title}</span>. Review each stage, approve the next move, and keep the committee fully supervised.
                                </p>
                                <div className="flex flex-wrap gap-2 text-xs text-content-tertiary">
                                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{candidate.email}</span>
                                    {candidate.githubUrl && <a href={candidate.githubUrl} target="_blank" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:text-white">GitHub</a>}
                                    {candidate.linkedinUrl && <a href={candidate.linkedinUrl} target="_blank" className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:text-white">LinkedIn</a>}
                                </div>
                            </div>

                            <div className="flex flex-col items-start sm:items-end gap-3">
                                <Link
                                    href="/vetting"
                                    className="inline-flex items-center gap-1.5 text-xs font-bold text-content-tertiary transition-colors hover:text-white"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                                    All Sessions
                                </Link>
                                <div className={`px-4 py-2 rounded-2xl border text-xs font-black uppercase tracking-[0.18em] ${
                                    isPlanning ? "border-amber-400/30 bg-amber-400/10 text-amber-300" :
                                    isResearching ? "border-sky-400/30 bg-sky-400/10 text-sky-300" :
                                    isAwaitingResearch ? "border-amber-400/30 bg-amber-400/10 text-amber-300" :
                                    isEvaluating ? "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300" :
                                    isAwaitingEvaluation ? "border-amber-400/30 bg-amber-400/10 text-amber-300" :
                                    isCompleted ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" :
                                    "border-white/10 bg-white/5 text-content-secondary"
                                }`}>
                                    {isPlanning ? "Planner Review" : isResearching ? "Researching" : isAwaitingResearch ? "Research Review" :
                                     isEvaluating ? "Evaluating" : isAwaitingEvaluation ? "Evaluation Review" :
                                     isCompleted ? "Completed" : "Session Active"}
                                </div>
                                <button
                                    onClick={handleRestartSession}
                                    disabled={restarting || executing}
                                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold text-content-secondary transition-all hover:border-brand-500/40 hover:text-white disabled:opacity-50"
                                >
                                    {restarting ? <div className="w-3.5 h-3.5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" /> : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path></svg>}
                                    Restart Session
                                </button>
                            </div>
                        </div>

                        <div className="mt-8 grid grid-cols-1 sm:grid-cols-4 gap-3">
                            {[
                                { step: 1, title: "Planner", description: "Approve the research plan before anything runs.", active: isPlanning, done: currentStep > 1 },
                                { step: 2, title: "Researcher", description: "Collect evidence from GitHub and public sources.", active: isResearching || isAwaitingResearch, done: currentStep > 2 },
                                { step: 3, title: "Evaluator", description: "Score fit, gaps, red flags, and follow-ups.", active: isEvaluating || isAwaitingEvaluation, done: currentStep > 3 },
                                { step: 4, title: "Report", description: "Review the hiring memo and final recommendation.", active: isCompleted, done: isCompleted },
                            ].map((stage) => (
                                <div
                                    key={stage.step}
                                    className={`rounded-2xl border p-4 transition-all ${
                                        stage.done ? "border-emerald-400/30 bg-emerald-400/8" :
                                        stage.active ? "border-brand-500/40 bg-brand-500/10 shadow-[0_0_0_1px_rgba(124,58,237,0.15)]" :
                                        "border-white/10 bg-white/[0.03]"
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${
                                            stage.done ? "bg-emerald-400 text-slate-950" : stage.active ? "bg-brand-500 text-white" : "bg-white/8 text-content-tertiary"
                                        }`}>
                                            {stage.step}
                                        </div>
                                        {stage.done && <span className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300">Done</span>}
                                        {stage.active && <span className="text-[10px] font-black uppercase tracking-[0.18em] text-brand-300">Now</span>}
                                    </div>
                                    <h3 className="mt-3 text-sm font-black text-white">{stage.title}</h3>
                                    <p className="mt-1 text-xs leading-relaxed text-content-secondary">{stage.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Dynamic Content Views */}
                {isRunning && (
                    <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 shadow-md">
                        <div className="flex items-center gap-4">
                            <div className="w-9 h-9 shrink-0 border-[3px] border-blue-500 border-t-transparent rounded-full animate-spin" />
                            <div className="min-w-0">
                                <h2 className="text-lg font-bold text-content-primary">
                                    {generatingReport ? "Report Writer Agent is compiling the hiring memo..." :
                                     isEvaluating ? "Evaluator Agent is scoring the candidate..." : "Researcher Agent is gathering evidence..."}
                                </h2>
                                <p className="text-content-secondary text-xs mt-0.5">
                                    {generatingReport
                                        ? "Turning the approved evaluation into a recruiter-facing summary and interview questions."
                                        : isEvaluating
                                        ? "Scoring each dimension against the cited evidence."
                                        : "Querying GitHub, coding profiles, portfolio sites, and grounded web search for verifiable evidence."}
                                </p>
                            </div>
                            <span className="ml-auto shrink-0 px-3 py-1 rounded-full text-xs font-bold bg-blue-500/10 text-blue-500 border border-blue-500/20">
                                Pass {Math.max(1, sessionData.finalReport?.research_iterations || (sessionData.researchResults?.length ? 1 : 1))} of 3
                            </span>
                        </div>

                        {/* Live agent step feed: every tool call/decision as it happens */}
                        {sessionData.logs && sessionData.logs.length > 0 && (
                            <div className="mt-6 bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden">
                                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
                                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Agent activity</span>
                                </div>
                                <div ref={stepFeedContainerRef} className="max-h-[280px] overflow-y-auto px-4 py-3 space-y-0">
                                    {sessionData.logs.map((log, idx) => {
                                        const isLatest = idx === sessionData.logs.length - 1;
                                        return (
                                            <div key={idx} className="flex items-start gap-2.5 py-1">
                                                <div className="flex flex-col items-center self-stretch shrink-0 pt-1">
                                                    <span className={`w-1.5 h-1.5 rounded-full ${isLatest ? "bg-emerald-400 animate-pulse" : "bg-slate-700"}`} />
                                                    {idx < sessionData.logs.length - 1 && <span className="w-px flex-1 bg-slate-800 mt-1" />}
                                                </div>
                                                <span className={`text-xs font-mono leading-relaxed break-all pb-1.5 ${isLatest ? "text-slate-100 font-semibold" : "text-slate-500"}`}>
                                                    {log}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {isFailed && (
                    <div className="bg-surface-card border border-rose-500/30 rounded-3xl p-8 sm:p-10 text-center flex flex-col items-center space-y-5 shadow-md animate-in fade-in duration-300">
                        <div className="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center">
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-content-primary">This run was interrupted</h2>
                            <p className="text-content-secondary text-sm max-w-md mx-auto mt-2">
                                The pipeline stopped before finishing. You can resume from the last completed
                                stage (keeps any research already gathered) or restart planning from scratch.
                            </p>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-3">
                            <button
                                onClick={handleResumeSession}
                                disabled={resuming}
                                className="px-6 py-3 bg-[image:var(--gradient-primary)] hover:opacity-95 active:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {resuming && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                Resume From Last Stage
                            </button>
                            <button
                                onClick={handleRestartSession}
                                disabled={restarting}
                                className="px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary active:scale-[0.98] text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer disabled:opacity-50"
                            >
                                Restart Planning
                            </button>
                        </div>
                        {sessionData.logs && sessionData.logs.length > 0 && (
                            <div className="w-full max-w-lg text-left bg-slate-950 text-slate-300 font-mono text-[0.7rem] rounded-2xl p-4 max-h-[120px] overflow-y-auto border border-slate-800 space-y-1">
                                {sessionData.logs.slice(-6).map((log, idx) => (
                                    <div key={idx} className="break-all">{log}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {isPlanning && (
                    <div className="space-y-8 animate-in fade-in duration-300">
                        {/* Core Skills Config */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                            <h3 className="text-lg font-bold text-content-primary">1. Focus Skills to Verify</h3>
                            <div className="flex flex-wrap gap-2">
                                {coreSkills.map((skill, idx) => (
                                    <span key={idx} className="px-3 py-1 bg-surface-secondary border border-border-default rounded-lg text-sm font-semibold text-content-primary flex items-center gap-1.5">
                                        {skill}
                                        <button onClick={() => handleRemoveSkill(idx)} className="text-content-tertiary hover:text-rose-500 transition-colors">
                                            &times;
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <div className="flex gap-2 max-w-sm">
                                <input 
                                    type="text" 
                                    id="new-skill-input"
                                    placeholder="Add skill (e.g. Next.js)..."
                                    className="flex-1 px-3 py-1.5 text-sm bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            handleAddSkill((e.target as HTMLInputElement).value);
                                            (e.target as HTMLInputElement).value = "";
                                        }
                                    }}
                                />
                                <button 
                                    onClick={() => {
                                        const el = document.getElementById("new-skill-input") as HTMLInputElement;
                                        if (el) {
                                            handleAddSkill(el.value);
                                            el.value = "";
                                        }
                                    }}
                                    className="px-4 py-1.5 bg-brand-500 text-white rounded-xl text-xs font-bold hover:bg-brand-600 transition-all"
                                >
                                    Add
                                </button>
                            </div>
                        </div>

                        {/* Research Query List (Ordered Accordion) */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-6 shadow-md">
                            <div className="flex justify-between items-center">
                                <h3 className="text-lg font-bold text-content-primary">2. Ordered Research Plan</h3>
                                <button 
                                    onClick={handleAddQuery}
                                    className="px-4 py-2 bg-brand-500 text-white hover:bg-brand-600 rounded-xl text-xs font-bold transition-all shadow-sm"
                                >
                                    + Add Item
                                </button>
                            </div>

                            {queries.length === 0 ? (
                                <p className="text-content-secondary text-sm italic">No research queries planned yet.</p>
                            ) : (
                                <div className="space-y-3">
                                    {queries.map((q, idx) => {
                                        const isExpanded = expandedQueryIndex === idx;
                                        return (
                                            <div key={idx} className={`border rounded-2xl transition-all duration-200 overflow-hidden ${isExpanded ? "border-brand-500 bg-surface-primary/30 shadow-md" : "border-border-default bg-surface-primary hover:border-brand-500/50"}`}>
                                                {/* Header (Always Visible) */}
                                                <div 
                                                    className="p-4 flex items-center justify-between cursor-pointer group"
                                                    onClick={() => setExpandedQueryIndex(isExpanded ? null : idx)}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <span className="w-6 h-6 rounded-full bg-brand-500/10 text-brand-500 text-xs font-extrabold flex items-center justify-center shrink-0">
                                                            {idx + 1}
                                                        </span>
                                                        <h4 className="font-bold text-sm text-content-primary group-hover:text-brand-500 transition-colors">
                                                            {q.heading || "Untitled Research Item"}
                                                        </h4>
                                                    </div>
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-xs font-semibold px-2 py-1 bg-surface-secondary rounded-md text-content-secondary">
                                                            {q.source}
                                                        </span>
                                                        <svg className={`w-5 h-5 text-content-tertiary transition-transform duration-200 ${isExpanded ? "rotate-180 text-brand-500" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                                                    </div>
                                                </div>

                                                {/* Expanded Body */}
                                                {isExpanded && (
                                                    <div className="p-4 pt-0 border-t border-border-default/50 space-y-4 animate-in fade-in duration-200">
                                                        <div className="mt-4 flex justify-between items-center">
                                                            <label className="text-xs font-bold text-content-secondary">Heading / Title</label>
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); handleDeleteQuery(idx); }}
                                                                className="text-xs font-bold text-rose-500 hover:text-rose-600 transition-colors"
                                                            >
                                                                Delete Item
                                                            </button>
                                                        </div>
                                                        <input 
                                                            type="text" 
                                                            value={q.heading}
                                                            onChange={(e) => handleUpdateQueryField(idx, "heading", e.target.value)}
                                                            className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none text-sm text-content-primary"
                                                        />

                                                        <div className="space-y-1">
                                                            <label className="text-xs font-bold text-content-secondary">Detailed Explanation & Goal</label>
                                                            <textarea 
                                                                rows={2}
                                                                value={q.explanation}
                                                                onChange={(e) => handleUpdateQueryField(idx, "explanation", e.target.value)}
                                                                placeholder="Why are we searching this? What should the agent conclude?"
                                                                className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none text-sm text-content-primary resize-none"
                                                            />
                                                        </div>

                                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                            <div className="space-y-1">
                                                                <label className="text-xs font-bold text-content-secondary">Source Platform</label>
                                                                <select 
                                                                    value={q.source} 
                                                                    onChange={(e) => handleUpdateQueryField(idx, "source", e.target.value)}
                                                                    className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none text-sm text-content-primary"
                                                                >
                                                                    <option value="GITHUB">GitHub</option>
                                                                    <option value="LINKEDIN">LinkedIn</option>
                                                                    <option value="WEB_SEARCH">Web Search</option>
                                                                </select>
                                                            </div>
                                                            <div className="space-y-1">
                                                                <label className="text-xs font-bold text-content-secondary">Search Queries (comma-separated)</label>
                                                                <input 
                                                                    type="text" 
                                                                    value={q.search_queries.join(", ")}
                                                                    onChange={(e) => handleUpdateSearchQueries(idx, e.target.value)}
                                                                    placeholder="query one, query two"
                                                                    className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none text-sm text-content-primary placeholder:text-content-tertiary"
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Past Company Questions */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-6 shadow-md">
                            <h3 className="text-lg font-bold text-content-primary">3. Company Vetting Questions</h3>
                            <div className="space-y-3">
                                {companyVettingQuestions.map((qText, idx) => (
                                    <div key={idx} className="flex items-start justify-between p-3 bg-surface-primary border border-border-default rounded-xl gap-3">
                                        <p className="text-sm text-content-secondary">{qText}</p>
                                        <button onClick={() => handleRemoveCompanyQuestion(idx)} className="text-content-tertiary hover:text-rose-500 transition-colors shrink-0">
                                            &times;
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <div className="flex gap-2 max-w-lg">
                                <input 
                                    type="text" 
                                    id="new-question-input"
                                    placeholder="Add inquiry (e.g. Verify past engineering responsibilities)..."
                                    className="flex-1 px-3 py-1.5 text-sm bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-content-primary"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            handleAddCompanyQuestion((e.target as HTMLInputElement).value);
                                            (e.target as HTMLInputElement).value = "";
                                        }
                                    }}
                                />
                                <button 
                                    onClick={() => {
                                        const el = document.getElementById("new-question-input") as HTMLInputElement;
                                        if (el) {
                                            handleAddCompanyQuestion(el.value);
                                            el.value = "";
                                        }
                                    }}
                                    className="px-4 py-1.5 bg-brand-500 text-white rounded-xl text-xs font-bold hover:bg-brand-600 transition-all"
                                >
                                    Add
                                </button>
                            </div>
                        </div>

                        {/* Plan Execution Footer Actions */}
                        <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                            <button
                                onClick={() => handleSavePlan(false)}
                                disabled={saving || executing}
                                className="px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary active:not-disabled:scale-[0.98] text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer disabled:opacity-50"
                            >
                                {saving ? "Saving Changes..." : "Save Plan Changes"}
                            </button>
                            <button
                                onClick={handleExecuteVetting}
                                disabled={primaryActionDisabled}
                                className="px-6 py-3 bg-[image:var(--gradient-primary)] hover:opacity-95 active:not-disabled:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-lg flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {executing && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                {primaryActionLabel}
                            </button>
                        </div>
                    </div>
                )}

                {isAwaitingResearch && (
                    <div className="space-y-8 animate-in fade-in duration-300">
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-6 shadow-md">
                            <div className="flex items-center justify-between gap-3">
                                <h3 className="text-lg font-bold text-content-primary">Research Findings</h3>
                                <span className="px-2.5 py-1 rounded-full text-[0.65rem] font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">
                                    {(Array.isArray(sessionData.researchResults) ? sessionData.researchResults.length : 0)} finding{(sessionData.researchResults?.length === 1) ? "" : "s"}
                                </span>
                            </div>

                            {!Array.isArray(sessionData.researchResults) || sessionData.researchResults.length === 0 ? (
                                <p className="text-content-secondary text-sm italic">No research findings yet.</p>
                            ) : (
                                <div className="space-y-3">
                                    {(sessionData.researchResults as ResearchFinding[]).map((r, idx) => (
                                        <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-2">
                                            <div className="flex items-start justify-between gap-3 flex-wrap">
                                                <h4 className="font-bold text-sm text-content-primary">{r.heading}</h4>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    {r.triggered_by === "human_followup" && (
                                                        <span className="px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">
                                                            Follow-up
                                                        </span>
                                                    )}
                                                    <span className="px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">
                                                        {r.source}
                                                    </span>
                                                    <span className={`px-2 py-0.5 rounded-md text-[0.65rem] font-bold uppercase border ${
                                                        r.status === "SUCCESS" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" :
                                                        r.status === "ERROR" ? "bg-rose-500/10 text-rose-600 border-rose-500/20" :
                                                        "bg-amber-500/10 text-amber-700 border-amber-500/20"
                                                    }`}>
                                                        {r.status}
                                                    </span>
                                                </div>
                                            </div>
                                            <p className="text-sm text-content-secondary leading-relaxed whitespace-pre-wrap">{r.findings}</p>
                                            {Array.isArray(r.urls) && r.urls.length > 0 && (
                                                <div className="flex flex-wrap gap-2 pt-1">
                                                    {r.urls.map((u, uidx) => {
                                                        const url = typeof u === "string" ? u : u.url;
                                                        const title = typeof u === "string" ? "" : (u.title || "");
                                                        if (!url) return null;
                                                        const label = title || url.replace(/^https?:\/\//, "").slice(0, 50);
                                                        return (
                                                            <a key={uidx} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                                {label}
                                                            </a>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Ask the Researcher (tool-calling HITL follow-up) */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                            <h3 className="text-lg font-bold text-content-primary">Ask the Researcher</h3>
                            <p className="text-sm text-content-secondary">
                                Type an instruction and the research agent will decide which tool to use (web search or GitHub) to dig deeper.
                            </p>
                            <textarea
                                rows={2}
                                value={followupText}
                                onChange={(e) => setFollowupText(e.target.value)}
                                placeholder="e.g. Check if they've written technical articles, or look for a MERN stack repo"
                                className="w-full px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-sm text-content-primary resize-none"
                            />
                            {lastToolCalls.length > 0 && (
                                <div className="flex flex-wrap gap-2">
                                    {lastToolCalls.map((tc, idx) => (
                                        <span key={idx} className="px-2.5 py-1 rounded-full text-[0.65rem] font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">
                                            🔧 called {tc.tool}({Object.entries(tc.args || {}).map(([k, v]) => `${k}="${v}"`).join(", ")})
                                        </span>
                                    ))}
                                </div>
                            )}
                            <div className="flex justify-end">
                                <button
                                    onClick={handleSubmitFollowup}
                                    disabled={submittingFollowup || !followupText.trim()}
                                    className="px-5 py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-sm font-bold transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                                >
                                    {submittingFollowup && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                    {submittingFollowup ? "Researching..." : "Ask & Research"}
                                </button>
                            </div>
                        </div>

                        <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                            <button
                                onClick={handleApproveResearch}
                                disabled={approvingResearch || submittingFollowup}
                                className="px-6 py-3 bg-[image:var(--gradient-primary)] hover:opacity-95 active:not-disabled:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-lg flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {approvingResearch && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                Approve Research & Move to Evaluation
                            </button>
                        </div>
                    </div>
                )}

                {isAwaitingEvaluation && sessionData.evaluation && (
                    <div className="space-y-8 animate-in fade-in duration-300">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div className="bg-surface-card border border-border-default rounded-3xl p-8 flex flex-col items-center justify-center text-center shadow-md">
                                <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest mb-4">Overall Fit Rating</h3>
                                <div className="relative w-36 h-36 flex items-center justify-center shrink-0 mb-4">
                                    <svg className="w-full h-full transform -rotate-90">
                                        <circle cx="72" cy="72" r="62" stroke="currentColor" strokeWidth="8" className="text-border-default" fill="transparent" />
                                        <circle
                                            cx="72" cy="72" r="62" stroke="currentColor" strokeWidth="8"
                                            strokeDasharray={2 * Math.PI * 62}
                                            strokeDashoffset={2 * Math.PI * 62 * (1 - (sessionData.evaluation.overall_fit_percentage || 0) / 100)}
                                            className="text-emerald-500" strokeLinecap="round" fill="transparent"
                                        />
                                    </svg>
                                    <span className="absolute text-3xl font-black text-content-primary">{sessionData.evaluation.overall_fit_percentage}%</span>
                                </div>
                                <span className={`px-4 py-1.5 rounded-full text-xs font-bold border uppercase tracking-wider ${
                                    sessionData.evaluation.evidence_sufficient === false
                                        ? "text-amber-700 bg-amber-500/10 border-amber-500/20"
                                        : "text-emerald-600 bg-emerald-500/10 border-emerald-500/20"
                                }`}>
                                    {sessionData.evaluation.evidence_sufficient === false ? "Evidence Thin" : "Evidence Sufficient"}
                                </span>
                            </div>

                            {sessionData.evaluation.dimension_scores && (
                                <div className="md:col-span-2 bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                    <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest">Evaluation Breakdown</h3>
                                    <div className="space-y-3">
                                        {([
                                            ["Skills", sessionData.evaluation.dimension_scores.skills],
                                            ["Experience", sessionData.evaluation.dimension_scores.experience],
                                            ["Project Complexity", sessionData.evaluation.dimension_scores.project_complexity],
                                            ["Education", sessionData.evaluation.dimension_scores.education],
                                            ["Public Work", sessionData.evaluation.dimension_scores.public_work],
                                        ] as [string, number | undefined][]).map(([label, value]) => {
                                            const v = typeof value === "number" ? value : 0;
                                            const color = v >= 75 ? "bg-emerald-500" : v >= 50 ? "bg-blue-500" : v >= 25 ? "bg-amber-500" : "bg-rose-500";
                                            return (
                                                <div key={label} className="space-y-1">
                                                    <div className="flex justify-between text-xs font-semibold text-content-secondary">
                                                        <span>{label}</span>
                                                        <span>{v}%</span>
                                                    </div>
                                                    <div className="w-full h-2 bg-surface-secondary rounded-full overflow-hidden border border-border-default">
                                                        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${v}%` }} />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary">Verified Skills</h3>
                                <ul className="space-y-2.5">
                                    {(sessionData.evaluation.verified_skills || []).map((skill, idx) => (
                                        <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                            <span className="text-emerald-500 shrink-0 mt-0.5">&bull;</span>
                                            <span>{skill}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary">Gaps or Concerns</h3>
                                {(sessionData.evaluation.gaps_or_concerns || []).length === 0 ? (
                                    <p className="text-sm text-content-tertiary italic">No key concerns or gaps identified.</p>
                                ) : (
                                    <ul className="space-y-2.5">
                                        {(sessionData.evaluation.gaps_or_concerns || []).map((gap, idx) => (
                                            <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                                <span className="text-amber-500 shrink-0 mt-0.5">&bull;</span>
                                                <span>{gap}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>

                        {sessionData.evaluation.evidence && sessionData.evaluation.evidence.length > 0 && (
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary">Evidence &amp; Sources</h3>
                                <div className="space-y-3">
                                    {sessionData.evaluation.evidence.map((ev, idx) => (
                                        <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-1.5">
                                            <div className="flex items-start justify-between gap-3">
                                                <p className="text-sm text-content-secondary leading-relaxed">{ev.claim}</p>
                                                <span className="shrink-0 px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">{ev.source_type}</span>
                                            </div>
                                            {ev.source_url && ev.source_url !== "resume" && (
                                                <a href={ev.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                    {ev.source_url.replace(/^https?:\/\//, "").slice(0, 60)}
                                                </a>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 bg-surface-card border border-border-default rounded-3xl p-6 shadow-md">
                            <button
                                onClick={handleRequestMoreResearch}
                                disabled={requestingMoreResearch || approvingEvaluation}
                                className="px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary active:not-disabled:scale-[0.98] text-content-secondary border border-border-default font-bold rounded-xl text-sm transition-all cursor-pointer disabled:opacity-50"
                            >
                                {requestingMoreResearch && <div className="inline-block w-4 h-4 mr-2 border-2 border-content-secondary border-t-transparent rounded-full animate-spin" />}
                                Request More Research
                            </button>
                            <button
                                onClick={handleApproveEvaluation}
                                disabled={approvingEvaluation || requestingMoreResearch}
                                className="px-6 py-3 bg-[image:var(--gradient-primary)] hover:opacity-95 active:not-disabled:scale-[0.98] text-white font-bold rounded-xl text-sm transition-all shadow-lg flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                {approvingEvaluation && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                Approve Evaluation & Generate Report
                            </button>
                        </div>
                    </div>
                )}

                {isCompleted && sessionData.finalReport && (
                    <div className="space-y-8 animate-in fade-in duration-300">
                        {/* Stage inspector: revisit any pipeline stage's stored output */}
                        <div className="bg-surface-card border border-border-default rounded-2xl p-2 shadow-md flex flex-wrap gap-2">
                            {([
                                ["plan", "1 · Plan"],
                                ["research", "2 · Research"],
                                ["evaluation", "3 · Evaluation"],
                                ["report", "4 · Final Report"],
                            ] as const).map(([key, label]) => (
                                <button
                                    key={key}
                                    onClick={() => setCompletedTab(key)}
                                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                                        completedTab === key
                                            ? "bg-brand-500 text-white shadow-sm"
                                            : "text-content-secondary hover:bg-surface-secondary"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Stage 1: Planner output (read-only) */}
                        {completedTab === "plan" && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                {!sessionData.researchPlan ? (
                                    <div className="bg-surface-card border border-border-default rounded-3xl p-8 text-center text-sm text-content-tertiary shadow-md">
                                        No planner output was stored for this session.
                                    </div>
                                ) : (
                                    <>
                                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                            <h3 className="text-lg font-bold text-content-primary">Core Skills to Verify</h3>
                                            <div className="flex flex-wrap gap-2">
                                                {(sessionData.researchPlan.core_skills_to_verify || []).map((skill, idx) => (
                                                    <span key={idx} className="px-3 py-1.5 rounded-full text-xs font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">
                                                        {skill}
                                                    </span>
                                                ))}
                                                {(sessionData.researchPlan.core_skills_to_verify || []).length === 0 && (
                                                    <span className="text-sm text-content-tertiary italic">None recorded.</span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                            <h3 className="text-lg font-bold text-content-primary">Research Plan ({(sessionData.researchPlan.research_plan || []).length} items)</h3>
                                            <div className="space-y-3">
                                                {(sessionData.researchPlan.research_plan || []).map((item, idx) => (
                                                    <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-1.5">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <p className="text-sm font-bold text-content-primary">{item.heading}</p>
                                                            <span className="shrink-0 px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">{item.source}</span>
                                                        </div>
                                                        {item.explanation && <p className="text-xs text-content-secondary leading-relaxed">{item.explanation}</p>}
                                                        {(item.search_queries || []).length > 0 && (
                                                            <div className="flex flex-wrap gap-1.5 pt-1">
                                                                {item.search_queries.map((q, qidx) => (
                                                                    <span key={qidx} className="px-2 py-0.5 rounded-md text-[0.7rem] font-mono bg-surface-secondary text-content-secondary border border-border-default">{q}</span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        {(sessionData.researchPlan.company_vetting?.questions || []).length > 0 && (
                                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                                <h3 className="text-lg font-bold text-content-primary">Company Vetting</h3>
                                                {(sessionData.researchPlan.company_vetting?.companies || []).length > 0 && (
                                                    <div className="flex flex-wrap gap-2">
                                                        {sessionData.researchPlan.company_vetting.companies.map((c, idx) => (
                                                            <span key={idx} className="px-3 py-1.5 rounded-full text-xs font-bold bg-surface-secondary text-content-secondary border border-border-default">{c}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                <ul className="space-y-2">
                                                    {sessionData.researchPlan.company_vetting.questions.map((q, idx) => (
                                                        <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                                            <span className="text-brand-500 shrink-0 mt-0.5">&bull;</span>
                                                            <span>{q}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {/* Stage 2: Research findings (read-only) */}
                        {completedTab === "research" && (
                            <div className="space-y-4 animate-in fade-in duration-300">
                                {!Array.isArray(sessionData.researchResults) || sessionData.researchResults.length === 0 ? (
                                    <div className="bg-surface-card border border-border-default rounded-3xl p-8 text-center text-sm text-content-tertiary shadow-md">
                                        No research findings were stored for this session.
                                    </div>
                                ) : (
                                    (sessionData.researchResults as ResearchFinding[]).map((finding, idx) => (
                                        <div key={idx} className="bg-surface-card border border-border-default rounded-2xl p-5 sm:p-6 space-y-2.5 shadow-md">
                                            <div className="flex items-start justify-between gap-3">
                                                <h4 className="text-sm font-bold text-content-primary">{finding.heading}</h4>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    {finding.triggered_by === "human_followup" && (
                                                        <span className="px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">FOLLOW-UP</span>
                                                    )}
                                                    <span className="px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">{finding.source}</span>
                                                    <span className={`px-2 py-0.5 rounded-md text-[0.65rem] font-bold border uppercase ${
                                                        finding.status === "SUCCESS"
                                                            ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                                                            : "bg-amber-500/10 text-amber-600 border-amber-500/20"
                                                    }`}>{finding.status}</span>
                                                </div>
                                            </div>
                                            <p className="text-sm text-content-secondary leading-relaxed whitespace-pre-wrap">{finding.findings}</p>
                                            {(finding.urls || []).length > 0 && (
                                                <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
                                                    {(finding.urls || []).map((u, uidx) => {
                                                        const url = typeof u === "string" ? u : u.url;
                                                        const title = typeof u === "string" ? "" : u.title || "";
                                                        if (!url) return null;
                                                        return (
                                                            <a key={uidx} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                                {title || url.replace(/^https?:\/\//, "").slice(0, 50)}
                                                            </a>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {/* Stage 3: Evaluation (read-only) */}
                        {completedTab === "evaluation" && (
                            <div className="space-y-6 animate-in fade-in duration-300">
                                {!sessionData.evaluation ? (
                                    <div className="bg-surface-card border border-border-default rounded-3xl p-8 text-center text-sm text-content-tertiary shadow-md">
                                        No evaluation data was stored for this session.
                                    </div>
                                ) : (
                                    <>
                                        {sessionData.evaluation.dimension_scores && (
                                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                                <div className="flex items-center justify-between gap-3">
                                                    <h3 className="text-lg font-bold text-content-primary">Dimension Scores</h3>
                                                    {typeof sessionData.evaluation.overall_fit_percentage === "number" && (
                                                        <span className="px-3 py-1.5 rounded-full text-xs font-black bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                                                            {sessionData.evaluation.overall_fit_percentage}% fit
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="space-y-3">
                                                    {([
                                                        ["Skills", sessionData.evaluation.dimension_scores.skills],
                                                        ["Experience", sessionData.evaluation.dimension_scores.experience],
                                                        ["Project Complexity", sessionData.evaluation.dimension_scores.project_complexity],
                                                        ["Education", sessionData.evaluation.dimension_scores.education],
                                                        ["Public Work", sessionData.evaluation.dimension_scores.public_work],
                                                    ] as [string, number | undefined][]).map(([label, value]) => {
                                                        const v = typeof value === "number" ? value : 0;
                                                        const color = v >= 75 ? "bg-emerald-500" : v >= 50 ? "bg-blue-500" : v >= 25 ? "bg-amber-500" : "bg-rose-500";
                                                        return (
                                                            <div key={label} className="space-y-1">
                                                                <div className="flex justify-between text-xs font-semibold text-content-secondary">
                                                                    <span>{label}</span>
                                                                    <span>{v}%</span>
                                                                </div>
                                                                <div className="w-full h-2 bg-surface-secondary rounded-full overflow-hidden border border-border-default">
                                                                    <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${v}%` }} />
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-3 shadow-md">
                                                <h3 className="text-base font-bold text-content-primary">Verified Skills</h3>
                                                {(sessionData.evaluation.verified_skills || []).length === 0 ? (
                                                    <p className="text-sm text-content-tertiary italic">None verified.</p>
                                                ) : (
                                                    <ul className="space-y-2">
                                                        {(sessionData.evaluation.verified_skills || []).map((s, idx) => (
                                                            <li key={idx} className="text-sm text-content-secondary flex items-start gap-2.5">
                                                                <span className="text-emerald-500 shrink-0 mt-0.5">&bull;</span>
                                                                <span>{s}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-3 shadow-md">
                                                <h3 className="text-base font-bold text-content-primary">Gaps &amp; Concerns</h3>
                                                {(sessionData.evaluation.gaps_or_concerns || []).length === 0 ? (
                                                    <p className="text-sm text-content-tertiary italic">No concerns recorded.</p>
                                                ) : (
                                                    <ul className="space-y-2">
                                                        {(sessionData.evaluation.gaps_or_concerns || []).map((g, idx) => (
                                                            <li key={idx} className="text-sm text-content-secondary flex items-start gap-2.5">
                                                                <span className="text-amber-500 shrink-0 mt-0.5">&bull;</span>
                                                                <span>{g}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        </div>
                                        {(sessionData.evaluation.evidence || []).length > 0 && (
                                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                                <h3 className="text-lg font-bold text-content-primary">Evidence Considered</h3>
                                                <div className="space-y-3">
                                                    {(sessionData.evaluation.evidence || []).map((ev, idx) => (
                                                        <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-1.5">
                                                            <div className="flex items-start justify-between gap-3">
                                                                <p className="text-sm text-content-secondary leading-relaxed">{ev.claim}</p>
                                                                <span className="shrink-0 px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">{ev.source_type}</span>
                                                            </div>
                                                            {ev.source_url && ev.source_url !== "resume" && (
                                                                <a href={ev.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                                    {ev.source_url.replace(/^https?:\/\//, "").slice(0, 60)}
                                                                </a>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {completedTab === "report" && (
                        <div className="space-y-8">
                        {/* Vetting Assessment Score Card */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {/* Score Dial */}
                            <div className="bg-surface-card border border-border-default rounded-3xl p-8 flex flex-col items-center justify-center text-center shadow-md">
                                <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest mb-4">Overall Fit Rating</h3>
                                <div className="relative w-36 h-36 flex items-center justify-center shrink-0 mb-4">
                                    <svg className="w-full h-full transform -rotate-90">
                                        <circle cx="72" cy="72" r="62" stroke="currentColor" strokeWidth="8" className="text-border-default" fill="transparent" />
                                        <circle 
                                            cx="72" 
                                            cy="72" 
                                            r="62" 
                                            stroke="currentColor" 
                                            strokeWidth="8" 
                                            strokeDasharray={2 * Math.PI * 62}
                                            strokeDashoffset={2 * Math.PI * 62 * (1 - (sessionData.finalReport.overall_fit_percentage || 0) / 100)}
                                            className="text-emerald-500"
                                            strokeLinecap="round"
                                            fill="transparent" 
                                        />
                                    </svg>
                                    <span className="absolute text-3xl font-black text-content-primary">{sessionData.finalReport.overall_fit_percentage}%</span>
                                </div>
                                <span className={`px-4 py-1.5 rounded-full text-xs font-bold border uppercase tracking-wider ${
                                    sessionData.finalReport.verdict === "STRONG_MATCH" ? "text-emerald-600 bg-emerald-500/10 border-emerald-500/20" :
                                    sessionData.finalReport.verdict === "POTENTIAL_MATCH" ? "text-blue-600 bg-blue-500/10 border-blue-500/20" :
                                    "text-rose-600 bg-rose-500/10 border-rose-500/20"
                                }`}>
                                    {sessionData.finalReport.verdict}
                                </span>
                            </div>

                            {/* Summary Text */}
                            <div className="md:col-span-2 bg-surface-card border border-border-default rounded-3xl p-8 flex flex-col justify-center shadow-md">
                                <div className="flex items-center justify-between gap-3 mb-2">
                                    <h3 className="text-xs font-bold text-content-tertiary uppercase tracking-widest">Recruit Summary</h3>
                                    {typeof sessionData.finalReport.research_iterations === "number" && (
                                        <span className="shrink-0 px-2.5 py-1 rounded-full text-[0.65rem] font-bold bg-brand-500/10 text-brand-500 border border-brand-500/20">
                                            {sessionData.finalReport.research_iterations} research pass{sessionData.finalReport.research_iterations === 1 ? "" : "es"}
                                        </span>
                                    )}
                                </div>
                                <p className="text-lg text-content-primary font-medium leading-relaxed">
                                    "{sessionData.finalReport.summary}"
                                </p>
                                {sessionData.finalReport.hiring_recommendation && (
                                    <div className="mt-4 pt-4 border-t border-border-default">
                                        <span className="text-xs font-bold text-content-tertiary uppercase tracking-widest">Recommendation</span>
                                        <p className="text-sm font-semibold text-brand-500 mt-1">{sessionData.finalReport.hiring_recommendation}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Dimension Scores */}
                        {sessionData.finalReport.dimension_scores && (
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary">Evaluation Breakdown</h3>
                                <div className="space-y-3">
                                    {([
                                        ["Skills", sessionData.finalReport.dimension_scores.skills],
                                        ["Experience", sessionData.finalReport.dimension_scores.experience],
                                        ["Project Complexity", sessionData.finalReport.dimension_scores.project_complexity],
                                        ["Education", sessionData.finalReport.dimension_scores.education],
                                        ["Public Work", sessionData.finalReport.dimension_scores.public_work],
                                    ] as [string, number | undefined][]).map(([label, value]) => {
                                        const v = typeof value === "number" ? value : 0;
                                        const color = v >= 75 ? "bg-emerald-500" : v >= 50 ? "bg-blue-500" : v >= 25 ? "bg-amber-500" : "bg-rose-500";
                                        return (
                                            <div key={label} className="space-y-1">
                                                <div className="flex justify-between text-xs font-semibold text-content-secondary">
                                                    <span>{label}</span>
                                                    <span>{v}%</span>
                                                </div>
                                                <div className="w-full h-2 bg-surface-secondary rounded-full overflow-hidden border border-border-default">
                                                    <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${v}%` }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Verified Skills & Concerns Gaps */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {/* Verified Skills */}
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                    <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                    Verified Skills & Details
                                </h3>
                                <ul className="space-y-2.5">
                                    {sessionData.finalReport.verified_skills.map((skill, idx) => (
                                        <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                            <span className="text-emerald-500 shrink-0 mt-0.5">&bull;</span>
                                            <span>{skill}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            {/* Concerns or Gaps */}
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                    <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                    Identified Gaps or Concerns
                                </h3>
                                {sessionData.finalReport.gaps_or_concerns.length === 0 ? (
                                    <p className="text-sm text-content-tertiary italic">No key concerns or gaps identified.</p>
                                ) : (
                                    <ul className="space-y-2.5">
                                        {sessionData.finalReport.gaps_or_concerns.map((gap, idx) => (
                                            <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                                <span className="text-amber-500 shrink-0 mt-0.5">&bull;</span>
                                                <span>{gap}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>

                        {/* Red Flags */}
                        {sessionData.finalReport.red_flags && sessionData.finalReport.red_flags.length > 0 && (
                            <div className="bg-rose-500/5 border border-rose-500/30 rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                    <svg className="w-5 h-5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 3v18M3 5h13l-2 4 2 4H3"></path></svg>
                                    Red Flags
                                </h3>
                                <ul className="space-y-2.5">
                                    {sessionData.finalReport.red_flags.map((flag, idx) => (
                                        <li key={idx} className="text-sm text-content-secondary leading-relaxed flex items-start gap-2.5">
                                            <span className="text-rose-500 shrink-0 mt-0.5">&bull;</span>
                                            <span>{flag}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Evidence with source links */}
                        {sessionData.finalReport.evidence && sessionData.finalReport.evidence.length > 0 && (
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                    <svg className="w-5 h-5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
                                    Evidence &amp; Sources
                                </h3>
                                <div className="space-y-3">
                                    {sessionData.finalReport.evidence.map((ev, idx) => (
                                        <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-1.5">
                                            <div className="flex items-start justify-between gap-3">
                                                <p className="text-sm text-content-secondary leading-relaxed">{ev.claim}</p>
                                                <span className="shrink-0 px-2 py-0.5 rounded-md text-[0.65rem] font-bold bg-surface-secondary text-content-tertiary border border-border-default uppercase">{ev.source_type}</span>
                                            </div>
                                            {ev.source_url && ev.source_url !== "resume" && (
                                                <a href={ev.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                    {ev.source_url.replace(/^https?:\/\//, "").slice(0, 60)}
                                                </a>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Narrative */}
                        {sessionData.finalReport.narrative && (
                            <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-3 shadow-md">
                                <h3 className="text-lg font-bold text-content-primary">Detailed Assessment</h3>
                                <p className="text-sm text-content-secondary leading-relaxed whitespace-pre-wrap">{sessionData.finalReport.narrative}</p>
                            </div>
                        )}

                        {/* Interview Questions */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                            <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                <svg className="w-5 h-5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                Suggested Interview Questions
                            </h3>
                            <div className="grid grid-cols-1 gap-3">
                                {sessionData.finalReport.interview_questions.map((q, idx) => (
                                    <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl flex items-start gap-3">
                                        <span className="text-brand-500 font-extrabold text-sm shrink-0">Q{idx + 1}.</span>
                                        <p className="text-sm text-content-secondary leading-relaxed">{q}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Q&A over the full accumulated research */}
                        <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                            <h3 className="text-lg font-bold text-content-primary flex items-center gap-2">
                                <svg className="w-5 h-5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-3 3-3-3z"></path></svg>
                                Ask About This Candidate
                            </h3>
                            <p className="text-sm text-content-secondary">
                                Ask a follow-up question grounded in the full research, evaluation, and report from this session.
                            </p>

                            {sessionData.qaHistory && sessionData.qaHistory.length > 0 && (
                                <div className="space-y-4">
                                    {sessionData.qaHistory.map((qa, idx) => (
                                        <div key={idx} className="p-4 bg-surface-primary border border-border-default rounded-xl space-y-2">
                                            <p className="text-sm font-bold text-content-primary">Q: {qa.question}</p>
                                            <p className="text-sm text-content-secondary leading-relaxed whitespace-pre-wrap">{qa.answer}</p>
                                            {qa.citations && qa.citations.length > 0 && (
                                                <div className="flex flex-wrap gap-2 pt-1">
                                                    {qa.citations.map((url, cidx) => (
                                                        <a key={cidx} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:underline break-all">
                                                            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                                                            {url.replace(/^https?:\/\//, "").slice(0, 50)}
                                                        </a>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={qaQuestion}
                                    onChange={(e) => setQaQuestion(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter" && !askingQuestion) handleAskQuestion(); }}
                                    placeholder="e.g. Does this candidate have relevant open source experience?"
                                    className="flex-1 px-3 py-2 bg-surface-secondary border border-border-default rounded-xl outline-none focus:border-brand-500 transition-all text-sm text-content-primary"
                                />
                                <button
                                    onClick={handleAskQuestion}
                                    disabled={askingQuestion || !qaQuestion.trim()}
                                    className="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-sm font-bold transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                                >
                                    {askingQuestion && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                                    {askingQuestion ? "Asking..." : "Ask"}
                                </button>
                            </div>
                        </div>
                        </div>
                        )}
                    </div>
                )}

                {/* Vetting Logs Terminal console (the "Agent Activity" panel above already
                    covers this live, so only show it once the run isn't actively streaming) */}
                {!isRunning && sessionData.logs && sessionData.logs.length > 0 && (
                    <div className="bg-surface-card border border-border-default rounded-3xl p-6 sm:p-8 space-y-4 shadow-md">
                        <h3 className="text-sm font-bold text-content-tertiary uppercase tracking-widest">Agent Execution Logs</h3>
                        <div className="bg-slate-950 text-slate-300 font-mono text-xs rounded-2xl p-4 overflow-y-auto max-h-[160px] space-y-1.5 border border-slate-800">
                            {sessionData.logs.map((log, idx) => (
                                <div key={idx} className="flex items-start gap-2">
                                    <span className="text-slate-500 shrink-0">[{idx + 1}]</span>
                                    <span className="break-all">{log}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Restart Overlay */}
            {(restarting || restartError) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-surface-card border border-border-default rounded-3xl p-8 max-w-sm w-full shadow-2xl flex flex-col items-center text-center space-y-4">
                        {restarting ? (
                            <>
                                <div className="relative w-16 h-16 flex items-center justify-center mb-2">
                                    <div className="absolute inset-0 border-4 border-brand-500/20 rounded-full"></div>
                                    <div className="absolute inset-0 border-4 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
                                    <svg className="w-6 h-6 text-brand-500 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                                </div>
                                <h3 className="text-xl font-bold text-content-primary">Re-running Planner...</h3>
                                <p className="text-sm text-content-secondary">
                                    Analyzing candidate profile and job description to construct a new research plan...
                                </p>
                            </>
                        ) : restartError ? (
                            <>
                                <div className="w-16 h-16 bg-rose-500/10 rounded-full flex items-center justify-center text-rose-500 mb-2 shrink-0">
                                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                                </div>
                                <h3 className="text-xl font-bold text-content-primary">Restart Failed</h3>
                                <p className="text-sm text-content-secondary break-words w-full">{restartError}</p>
                                <button 
                                    onClick={() => setRestartError("")}
                                    className="mt-4 px-6 py-2 bg-surface-tertiary hover:bg-surface-secondary text-content-primary font-bold rounded-xl transition-all w-full"
                                >
                                    Close
                                </button>
                            </>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}
