import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, email, password, role } = body;

        if (!email || !password) {
            return NextResponse.json(
                { error: "Email and password are required" },
                { status: 400 }
            );
        }

        if (password.length < 6) {
            return NextResponse.json(
                { error: "Password must be at least 6 characters" },
                { status: 400 }
            );
        }

        const existingUser = await prisma.user.findUnique({
            where: { email },
            include: { accounts: true },
        });

        if (existingUser) {
            const hasGoogle = existingUser.accounts.some((a) => a.provider === "google");
            if (hasGoogle) {
                return NextResponse.json(
                    {
                        error: "This email is already registered with Google. Please sign in with Google instead.",
                        code: "GOOGLE_ACCOUNT",
                    },
                    { status: 409 }
                );
            }
            return NextResponse.json(
                { error: "An account with this email already exists" },
                { status: 409 }
            );
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const userRole = role === "RECRUITER" ? "RECRUITER" : "CANDIDATE";

        const user = await prisma.user.create({
            data: {
                name,
                email,
                hashedPassword,
                role: userRole,
                // Automatically create a blank Candidate profile if they sign up as a candidate
                ...(userRole === "CANDIDATE" ? {
                    candidate: {
                        create: {
                            name: name || "",
                            email: email,
                        }
                    }
                } : {})
            },
        });

        return NextResponse.json(
            {
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                },
            },
            { status: 201 }
        );
    } catch (error) {
        console.error("Registration error:", error);
        return NextResponse.json(
            { error: "Something went wrong. Please try again." },
            { status: 500 }
        );
    }
}
