import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

// GET /api/companies/my — list companies owned by the current user
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "You must be logged in" },
                { status: 401 }
            );
        }

        const companies = await prisma.company.findMany({
            where: { ownerId: session.user.id },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json({ companies });
    } catch (error) {
        console.error("Error fetching user companies:", error);
        return NextResponse.json(
            { error: "Failed to fetch your companies" },
            { status: 500 }
        );
    }
}
