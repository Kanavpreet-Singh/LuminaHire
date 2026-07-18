import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

export default async function VettingSessionsList() {
    const session = await auth();
    
    if (!session?.user) {
        redirect("/login");
    }

    if ((session.user as any).role !== "RECRUITER") {
        redirect("/profile");
    }

    const vettingSessions = await prisma.vettingSession.findMany({
        where: {
            application: {
                job: {
                    recruiterId: session.user.id
                }
            }
        },
        include: {
            application: {
                include: {
                    candidate: true,
                    job: true
                }
            }
        },
        orderBy: {
            updatedAt: "desc"
        }
    });

    return (
        <div className="flex-1 bg-surface-primary py-12 px-6 sm:px-12 relative overflow-hidden">
            <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
                <div className="absolute top-[-10%] right-[-5%] w-96 h-96 bg-brand-500/20 rounded-full blur-[100px] animate-pulse"></div>
                <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px]"></div>
            </div>

            <div className="max-w-6xl mx-auto space-y-10 relative z-10">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 bg-surface-card backdrop-blur-xl p-6 sm:p-8 rounded-3xl border border-border-default shadow-lg">
                    <div>
                        <span className="text-xs font-bold text-brand-500 uppercase tracking-widest">AI Agent Management</span>
                        <h1 className="text-2xl sm:text-3xl font-extrabold text-content-primary mt-1">Recruit Sessions (HITL)</h1>
                        <p className="text-content-secondary mt-1 text-sm">Review, edit, and monitor AI agent research plans and execution states.</p>
                    </div>
                    <Link href="/dashboard" className="px-6 py-3 bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default rounded-xl font-bold transition-all shadow-sm text-sm">
                        Back to Dashboard
                    </Link>
                </div>

                <div className="bg-surface-card backdrop-blur-xl p-8 rounded-3xl border border-border-default shadow-lg">
                    {vettingSessions.length === 0 ? (
                        <div className="text-center py-16 border-2 border-dashed border-border-default rounded-3xl">
                            <svg className="w-12 h-12 mx-auto text-content-tertiary mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
                            <p className="text-content-secondary font-semibold">No Recruit Sessions found.</p>
                            <p className="text-content-tertiary text-sm mt-2">Go to the Recruiter Dashboard, view AI Matches for a job, and click "Agent Recruit" to initiate a session.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {vettingSessions.map((vs, idx) => (
                                <div
                                    key={vs.id}
                                    className="group p-6 bg-surface-primary border border-border-default rounded-2xl flex flex-col gap-4 hover:border-brand-500/50 hover:shadow-xl transition-all duration-300 animate-fadeInUp"
                                    style={{ animationDelay: `${Math.min(idx * 0.05, 0.3)}s` }}
                                >
                                    <div className="flex justify-between items-start">
                                        <div className="min-w-0">
                                            <h3 className="font-bold text-content-primary truncate text-lg">{vs.application.candidate.name}</h3>
                                            <p className="text-xs font-semibold text-content-tertiary truncate">for {vs.application.job.title}</p>
                                        </div>
                                        <span className={`shrink-0 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded-full border ${
                                            vs.status === "COMPLETED" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" :
                                            vs.status === "RESEARCHING" || vs.status === "EVALUATING" ? "bg-blue-500/10 text-blue-600 border-blue-500/20 animate-pulse" :
                                            vs.status === "FAILED" ? "bg-rose-500/10 text-rose-600 border-rose-500/20" :
                                            "bg-amber-500/10 text-amber-600 border-amber-500/20"
                                        }`}>
                                            {vs.status}
                                        </span>
                                    </div>
                                    
                                    <div className="flex flex-col gap-1 flex-1">
                                        <span className="text-xs text-content-secondary flex items-center gap-2">
                                            <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                            Updated {vs.updatedAt.toLocaleDateString()}
                                        </span>
                                        {vs.status === "COMPLETED" && (vs.finalReport as any)?.overall_fit_percentage !== undefined && (
                                            <span className="text-xs font-bold text-emerald-500 mt-2">
                                                Final Fit Score: {(vs.finalReport as any).overall_fit_percentage}%
                                            </span>
                                        )}
                                    </div>

                                    <Link 
                                        href={`/vetting/${vs.id}`}
                                        className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all text-center no-underline flex items-center justify-center gap-2 ${
                                            vs.status === "COMPLETED" 
                                            ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-md"
                                            : vs.status === "PLANNING"
                                            ? "bg-[image:var(--gradient-primary)] hover:opacity-95 text-white shadow-md hover:-translate-y-0.5"
                                            : "bg-surface-tertiary hover:bg-surface-secondary text-content-secondary border border-border-default"
                                        }`}
                                    >
                                        {vs.status === "COMPLETED" ? "View Report" : vs.status === "PLANNING" ? "Edit Plan (HITL)" : "View Status"}
                                    </Link>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
