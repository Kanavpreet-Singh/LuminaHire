import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

// GET /api/companies/[id] — get single company with owner info
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        const company = await prisma.company.findUnique({
            where: { id },
            include: {
                owner: {
                    select: { id: true, name: true, email: true, image: true },
                },
            },
        });

        if (!company) {
            return NextResponse.json(
                { error: "Company not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({ company });
    } catch (error) {
        console.error("Error fetching company:", error);
        return NextResponse.json(
            { error: "Failed to fetch company" },
            { status: 500 }
        );
    }
}

// PUT /api/companies/[id] — update company info (owner only)
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "You must be logged in" },
                { status: 401 }
            );
        }

        const { id } = await params;

        const company = await prisma.company.findUnique({
            where: { id },
        });

        if (!company) {
            return NextResponse.json(
                { error: "Company not found" },
                { status: 404 }
            );
        }

        if (company.ownerId !== session.user.id) {
            return NextResponse.json(
                { error: "You are not the owner of this company" },
                { status: 403 }
            );
        }

        const body = await request.json();
        const { info, name } = body;

        const updateData: { info?: string; name?: string } = {};

        if (typeof info === "string") {
            updateData.info = info;
        }

        if (typeof name === "string" && name.trim().length > 0) {
            if (name.trim().length > 100) {
                return NextResponse.json(
                    { error: "Company name must be less than 100 characters" },
                    { status: 400 }
                );
            }
            updateData.name = name.trim();
        }

        const updated = await prisma.company.update({
            where: { id },
            data: updateData,
            include: {
                owner: {
                    select: { id: true, name: true, email: true },
                },
            },
        });

        return NextResponse.json({ company: updated });
    } catch (error) {
        console.error("Error updating company:", error);
        return NextResponse.json(
            { error: "Failed to update company" },
            { status: 500 }
        );
    }
}

// DELETE /api/companies/[id] — delete a company (owner only)
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "You must be logged in" },
                { status: 401 }
            );
        }

        const { id } = await params;

        const company = await prisma.company.findUnique({
            where: { id },
        });

        if (!company) {
            return NextResponse.json(
                { error: "Company not found" },
                { status: 404 }
            );
        }

        if (company.ownerId !== session.user.id) {
            return NextResponse.json(
                { error: "You are not the owner of this company" },
                { status: 403 }
            );
        }

        await prisma.company.delete({
            where: { id },
        });

        return NextResponse.json({ message: "Company deleted successfully" });
    } catch (error) {
        console.error("Error deleting company:", error);
        return NextResponse.json(
            { error: "Failed to delete company" },
            { status: 500 }
        );
    }
}
