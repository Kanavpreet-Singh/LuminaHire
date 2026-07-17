import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { deleteCompanyPdf, uploadCompanyPdf } from "@/lib/cloudinary";

async function readCompanyRequest(request: Request) {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();

        return {
            name: formData.get("name"),
            info: formData.get("info"),
            pdf: formData.get("pdf"),
        };
    }

    const body = await request.json();

    return {
        name: body.name,
        info: body.info,
        pdf: null,
    };
}

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
    let pdfUpload: Awaited<ReturnType<typeof uploadCompanyPdf>> | null = null;

    try {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "You must be logged in to create a company" },
                { status: 401 }
            );
        }

        const { name, info, pdf } = await readCompanyRequest(request);

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

        if (pdf instanceof File && pdf.size > 0) {
            if (pdf.type !== "application/pdf") {
                return NextResponse.json(
                    { error: "Only PDF files are allowed" },
                    { status: 400 }
                );
            }

            if (pdf.size > 15 * 1024 * 1024) {
                return NextResponse.json(
                    { error: "PDF must be 15MB or smaller" },
                    { status: 400 }
                );
            }

            pdfUpload = await uploadCompanyPdf(pdf);
        }

        const company = await prisma.company.create({
            data: {
                name: name.trim(),
                ownerId: session.user.id,
                info: typeof info === "string" ? info.trim() : undefined,
                pdfUrl: pdfUpload?.url,
                pdfPublicId: pdfUpload?.publicId,
            },
            include: {
                owner: {
                    select: { id: true, name: true, email: true },
                },
            },
        });

        return NextResponse.json({ company }, { status: 201 });
    } catch (error) {
        if (pdfUpload?.publicId) {
            void deleteCompanyPdf(pdfUpload.publicId).catch((cleanupError) => {
                console.error("Error deleting uploaded PDF after create failure:", cleanupError);
            });
        }
        console.error("Error creating company:", error);
        return NextResponse.json(
            { error: "Failed to create company" },
            { status: 500 }
        );
    }
}
