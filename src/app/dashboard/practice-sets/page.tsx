import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { redirect } from "next/navigation";
import PracticeSetsClient from "./PracticeSetsClient";

/**
 * Practice-set review for recruiters.
 *
 * Jobs are read here rather than through /api/jobs because that endpoint
 * returns every OPEN job regardless of owner — correct for the candidate job
 * board it serves, wrong for a page whose actions require ownership.
 */
export default async function PracticeSetsPage() {
    const session = await auth();
    if (!session?.user) redirect("/login");
    if ((session.user as any).role !== "RECRUITER") redirect("/");

    const jobs = await prisma.jobPosting.findMany({
        where: { recruiterId: session.user.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, status: true },
    });

    return (
        <div className="flex-1 bg-surface-primary text-content-primary">
            <PracticeSetsClient jobs={jobs} />
        </div>
    );
}
