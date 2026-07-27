import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { PYTHON_API_URL } from "@/lib/vetting";

/**
 * What the analysis service on this deployment can actually measure.
 *
 * The practice UI reads this before offering to record. Discovering that a
 * server has no ffmpeg AFTER someone records a three-minute answer is the worst
 * possible time to find out, so the mode picker falls back to typing when
 * `media_analysis_ready` is false and says why.
 *
 * If the Python service is unreachable we report not-ready rather than
 * erroring: an unavailable analyzer and an unreachable one have the same
 * consequence for the person choosing how to answer.
 */
export async function GET() {
    const session = await auth();
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 });

    try {
        const res = await fetch(`${PYTHON_API_URL}/mock/capabilities`, {
            cache: "no-store",
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(String(res.status));
        return NextResponse.json(await res.json());
    } catch {
        return NextResponse.json({
            media_analysis_ready: false,
            reason: "The analysis service is unreachable.",
        });
    }
}
