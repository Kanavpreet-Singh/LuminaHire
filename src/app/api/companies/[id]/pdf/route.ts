import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { deleteCompanyPdf } from "@/lib/cloudinary";

// DELETE /api/companies/[id]/pdf — remove company PDF (owner only)
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

        if (!company.pdfPublicId) {
            return NextResponse.json(
                { error: "No PDF to delete" },
                { status: 400 }
            );
        }

        await deleteCompanyPdf(company.pdfPublicId);

        const updated = await prisma.company.update({
            where: { id },
            data: {
                pdfUrl: null,
                pdfPublicId: null,
            },
            include: {
                owner: {
                    select: { id: true, name: true, email: true },
                },
            },
        });

        return NextResponse.json({ company: updated });
    } catch (error) {
        console.error("Error deleting company PDF:", error);
        return NextResponse.json(
            { error: "Failed to delete company PDF" },
            { status: 500 }
        );
    }
}