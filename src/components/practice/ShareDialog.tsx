"use client";

import { useEffect, useState } from "react";

/**
 * Attach a finished practice session to one of your own applications.
 *
 * The preview is not decoration. Consent to share isn't meaningful if you can't
 * see what you're sharing, so this shows the exact recruiter-visible payload —
 * built by the same allowlist serializer the API uses — before you confirm.
 *
 * Delivery and presence scores never appear here, because they never leave the
 * candidate. Neither does the recording.
 */

type SharePreview = {
    scores: { content: number | null; language: number | null };
    answers: { question: string; contentScore: number | null; answerText: string | null }[];
};

type Notice = { shared: string[]; notShared: string[] };

export default function ShareDialog({
    mockId,
    applications,
    onClose,
}: {
    mockId: string;
    applications: { id: string; jobTitle: string; companyName: string }[];
    onClose: () => void;
}) {
    const [preview, setPreview] = useState<SharePreview | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [shared, setShared] = useState<{ applicationId: string; revokedAt: string | null } | null>(null);
    const [selected, setSelected] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`/api/mock/${mockId}/share`)
            .then(async (r) => {
                if (!r.ok) throw new Error(await r.text());
                return r.json();
            })
            .then((d) => {
                setPreview(d.preview);
                setNotice(d.notice);
                setShared(d.share);
                if (d.share?.applicationId && !d.share.revokedAt) setSelected(d.share.applicationId);
            })
            .catch((e) => setError(e.message || "Couldn't load the preview"));
    }, [mockId]);

    const isLive = shared && !shared.revokedAt;

    async function share() {
        if (!selected) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/mock/${mockId}/share`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ applicationId: selected }),
            });
            if (!res.ok) throw new Error(await res.text());
            const d = await res.json();
            setShared(d.share);
        } catch (e: any) {
            setError(e.message || "Couldn't share this session");
        } finally {
            setBusy(false);
        }
    }

    async function revoke() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/mock/${mockId}/share`, { method: "DELETE" });
            if (!res.ok) throw new Error(await res.text());
            setShared((s) => (s ? { ...s, revokedAt: new Date().toISOString() } : s));
        } catch (e: any) {
            setError(e.message || "Couldn't revoke the share");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Share this session"
            onClick={onClose}
        >
            <div
                className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-border-default bg-surface-primary p-6 shadow-lg"
                onClick={(e) => e.stopPropagation()}
            >
                <h2 className="text-lg font-bold text-content-primary">Share with a recruiter</h2>
                <p className="mt-1 text-sm text-content-secondary">
                    Attach this session to one of your applications. You can take it back at any time.
                </p>

                {error && (
                    <p className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
                        {error}
                    </p>
                )}

                {notice && (
                    <div className="mt-5 grid gap-4 sm:grid-cols-2">
                        <div>
                            <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-400">
                                They see
                            </h3>
                            <ul className="space-y-1">
                                {notice.shared.map((s, i) => (
                                    <li key={i} className="text-xs text-content-secondary">{s}</li>
                                ))}
                            </ul>
                        </div>
                        <div>
                            <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                                They never see
                            </h3>
                            <ul className="space-y-1">
                                {notice.notShared.map((s, i) => (
                                    <li key={i} className="text-xs text-content-tertiary">{s}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {preview && (
                    <details className="mt-5 rounded-2xl border border-border-default bg-surface-secondary/60 p-4">
                        <summary className="cursor-pointer text-xs font-bold text-content-secondary">
                            Preview exactly what they&apos;d see
                        </summary>
                        <div className="mt-3 space-y-3">
                            <p className="text-xs text-content-tertiary tabular-nums">
                                Content {preview.scores.content ?? "—"} · Language {preview.scores.language ?? "—"}
                            </p>
                            {preview.answers.map((a, i) => (
                                <div key={i} className="rounded-xl border border-border-default bg-surface-card p-3">
                                    <p className="text-xs font-semibold text-content-primary">{a.question}</p>
                                    <p className="mt-1 line-clamp-3 text-xs text-content-tertiary">
                                        {a.answerText || "—"}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </details>
                )}

                {applications.length === 0 ? (
                    <p className="mt-5 rounded-xl border border-border-default bg-surface-secondary/60 p-3 text-sm text-content-tertiary">
                        You haven&apos;t applied to this role yet. Apply first, then share your practice with
                        that application.
                    </p>
                ) : (
                    <div className="mt-5">
                        <label
                            htmlFor="app"
                            className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary"
                        >
                            Application
                        </label>
                        <select
                            id="app"
                            value={selected}
                            onChange={(e) => setSelected(e.target.value)}
                            className="w-full cursor-pointer rounded-xl border border-border-default bg-surface-secondary px-4 py-2.5 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-primary-500/40"
                        >
                            <option value="">Choose an application…</option>
                            {applications.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.jobTitle} — {a.companyName}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {isLive && (
                    <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-400">
                        Shared. The recruiter can see your content scores and what you said.
                    </p>
                )}

                <div className="mt-6 flex flex-wrap gap-3">
                    {isLive ? (
                        <button
                            onClick={revoke}
                            disabled={busy}
                            className="cursor-pointer rounded-xl border border-border-default px-5 py-2.5 text-sm font-bold text-content-secondary transition-colors hover:text-content-primary disabled:opacity-50"
                        >
                            {busy ? "Taking it back…" : "Stop sharing"}
                        </button>
                    ) : (
                        <button
                            onClick={share}
                            disabled={busy || !selected}
                            className="cursor-pointer rounded-xl bg-[image:var(--gradient-primary)] px-6 py-2.5 text-sm font-bold text-white shadow-glow transition-all hover:-translate-y-px disabled:opacity-40 disabled:hover:translate-y-0"
                        >
                            {busy ? "Sharing…" : "Share"}
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="cursor-pointer rounded-xl px-4 py-2.5 text-sm font-bold text-content-tertiary transition-colors hover:text-content-primary"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
