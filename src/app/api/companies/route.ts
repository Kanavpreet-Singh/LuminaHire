import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

// GET /api/companies — list all companies (public listing)
export async function GET() {
    try {
        const companies = await prisma.company.findMany({
            include: {
                owner: {
                    select: { id: true, name: true, email: true, image: true },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json({ companies });
    } catch (error) {
        console.error("Error fetching companies:", error);
        return NextResponse.json(
            { error: "Failed to fetch companies" },
            { status: 500 }
        );
    }
}

// POST /api/companies — create a new company
export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "You must be logged in to create a company" },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { name } = body;

        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return NextResponse.json(
                { error: "Company name is required" },
                { status: 400 }
            );
        }

        if (name.trim().length > 100) {
            return NextResponse.json(
                { error: "Company name must be less than 100 characters" },
                { status: 400 }
            );
        }

        const company = await prisma.company.create({
            data: {
                name: name.trim(),
                ownerId: session.user.id,
            },
            include: {
                owner: {
                    select: { id: true, name: true, email: true },
                },
            },
        });

        return NextResponse.json({ company }, { status: 201 });
    } catch (error) {
        console.error("Error creating company:", error);
        return NextResponse.json(
            { error: "Failed to create company" },
            { status: 500 }
        );
    }
}
