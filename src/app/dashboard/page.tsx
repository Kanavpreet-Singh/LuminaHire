import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { redirect } from "next/navigation";
import RecruiterDashboard from "@/components/RecruiterDashboard";

export default async function DashboardPage() {
    const session = await auth();
    
    if (!session?.user) {
        redirect("/login");
    }

    if ((session.user as any).role !== "RECRUITER") {
        redirect("/");
    }

    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        include: { 
            jobPostings: {
                orderBy: { createdAt: "desc" }
            }
        }
    });

    if (!user) return redirect("/login");

    // Map fields cleanly to avoid date serialization issues if any
    const initialJobs = (user.jobPostings || []).map(job => ({
        id: job.id,
        title: job.title,
        description: job.description,
        requirements: job.requirements,
        status: job.status,
        createdAt: job.createdAt
    }));

    return (
        <div className="flex-1 bg-surface-primary text-content-primary py-12 px-4 sm:px-6 lg:px-8 relative">
            {/* Background mesh glows with contained overflow */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                <div className="absolute inset-0 hero-grid-pattern opacity-30" />
                <div className="absolute -top-[20%] left-[10%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.06)_0%,transparent_70%)] blur-[100px]" />
                <div className="absolute -bottom-[20%] right-[10%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.05)_0%,transparent_70%)] blur-[100px]" />
            </div>

            <div className="max-w-6xl mx-auto space-y-10 relative z-10">
                <RecruiterDashboard 
                    initialUser={{
                        name: user.name,
                        email: user.email,
                        companyName: user.companyName
                    }}
                    initialJobs={initialJobs}
                />
            </div>
        </div>
    );
}
