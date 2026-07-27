"use client";

import { useMemo } from "react";

/**
 * The answer ribbon — the shape of a spoken answer over time.
 *
 * Every other interview tool shows you a score. The thing only this product can
 * show you is what your answer actually LOOKED like: where the speaking was
 * dense, where the silences fell, the moment at 1:11 where you lost the thread,
 * and (on video) where your eyes left the lens.
 *
 * Every mark here is a measurement, never a decoration:
 *   voiced lane   1 Hz voiced fraction from VAD
 *   stall marks   real timestamps of gaps over 2.5s
 *   gaze lane     1 Hz camera-facing fraction from the face track
 *   target mark   where this question's answer was meant to end
 *
 * Marks are clickable and seek the player, which is the whole point: watching
 * yourself stall at 0:34 teaches more than reading that you stalled three times.
 */

export type SpeechTimelinePoint = { t: number; voiced: number };
export type FaceTimelinePoint = { t: number; present: number; facing: number };
export type AffectTimelinePoint = { t: number; v: number; a: number };

export default function AnswerRibbon({
    durationSeconds,
    targetSeconds,
    speechTimeline,
    faceTimeline,
    affectTimeline,
    stallTimestamps = [],
    onSeek,
}: {
    durationSeconds: number;
    targetSeconds?: number | null;
    speechTimeline?: SpeechTimelinePoint[] | null;
    faceTimeline?: FaceTimelinePoint[] | null;
    affectTimeline?: AffectTimelinePoint[] | null;
    stallTimestamps?: number[];
    onSeek?: (seconds: number) => void;
}) {
    const duration = Math.max(1, durationSeconds || 0);

    const speech = useMemo(() => speechTimeline ?? [], [speechTimeline]);
    const gaze = useMemo(() => faceTimeline ?? [], [faceTimeline]);
    const affect = useMemo(() => affectTimeline ?? [], [affectTimeline]);
    const hasSpeech = speech.length > 0;
    const hasGaze = gaze.length > 0;
    const hasAffect = affect.length > 1;

    if (!hasSpeech && !hasGaze && !hasAffect && stallTimestamps.length === 0) return null;

    const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`;
    const overran = targetSeconds ? duration > targetSeconds : false;

    return (
        <figure className="not-prose m-0">
            <div className="flex items-baseline justify-between mb-2">
                <figcaption className="text-[10px] font-bold uppercase tracking-[0.14em] text-content-tertiary">
                    Shape of your answer
                </figcaption>
                <span className="text-[11px] text-content-tertiary tabular-nums">
                    {formatClock(duration)}
                    {targetSeconds ? (
                        <span className={overran ? "text-amber-400" : "text-content-tertiary"}>
                            {" "}/ {formatClock(targetSeconds)} target
                        </span>
                    ) : null}
                </span>
            </div>

            <div className="relative rounded-xl border border-border-default bg-surface-secondary/60 p-2.5">
                {/* Voiced lane. Bar height is the voiced fraction of that second,
                    so silence reads as a genuine gap rather than a colour. */}
                {hasSpeech && (
                    <div className="relative flex h-9 items-end gap-px" aria-hidden="true">
                        {speech.map((point) => (
                            <div
                                key={point.t}
                                className="flex-1 rounded-[1px] bg-primary-400/70 motion-safe:transition-[height] motion-safe:duration-500"
                                style={{ height: `${Math.max(4, point.voiced * 100)}%` }}
                            />
                        ))}
                    </div>
                )}

                {/* Gaze lane. Only on video answers, and deliberately thinner than
                    the voiced lane — what you said outranks where you looked. */}
                {hasGaze && (
                    <div className="relative mt-1.5 flex h-1.5 gap-px" aria-hidden="true">
                        {gaze.map((point) => (
                            <div
                                key={point.t}
                                className="flex-1 rounded-[1px]"
                                style={{
                                    backgroundColor:
                                        point.facing >= 0.6
                                            ? "rgb(52 211 153 / 0.55)"
                                            : "rgb(251 113 133 / 0.55)",
                                }}
                            />
                        ))}
                    </div>
                )}

                {/* Expression trace: valence over time, drawn as a line through
                    the middle of the strip. A flat line IS the finding — it means
                    your face didn't move — so this is deliberately not smoothed
                    into something prettier than the data. */}
                {hasAffect && (
                    <svg
                        viewBox={`0 0 ${affect.length - 1} 2`}
                        preserveAspectRatio="none"
                        className="mt-1.5 h-6 w-full overflow-visible"
                        role="img"
                        aria-label="How expressive your face was over the answer"
                    >
                        <line
                            x1="0" y1="1" x2={affect.length - 1} y2="1"
                            stroke="currentColor" strokeWidth="0.5"
                            className="text-border-default"
                            vectorEffect="non-scaling-stroke"
                        />
                        <polyline
                            points={affect.map((p, i) => `${i},${1 - Math.max(-1, Math.min(1, p.v))}`).join(" ")}
                            fill="none"
                            stroke="var(--accent-400)"
                            strokeWidth="1.5"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                )}

                {/* Where the answer was meant to end. */}
                {targetSeconds && targetSeconds < duration && (
                    <div
                        className="pointer-events-none absolute inset-y-2 w-px bg-amber-400/50"
                        style={{ left: pct(targetSeconds) }}
                        aria-hidden="true"
                    />
                )}

                {/* Stalls: the one thing on this strip worth clicking. */}
                {stallTimestamps.map((t) => (
                    <button
                        key={t}
                        type="button"
                        onClick={() => onSeek?.(t)}
                        style={{ left: pct(t) }}
                        className="group absolute top-1 -translate-x-1/2 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded"
                        title={`Stall at ${formatClock(t)} — jump here`}
                    >
                        <span className="block h-9 w-0.5 bg-amber-400" />
                        <span className="mt-1 block text-[9px] font-bold tabular-nums text-amber-400 opacity-70 group-hover:opacity-100">
                            {formatClock(t)}
                        </span>
                    </button>
                ))}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-content-tertiary">
                {hasSpeech && <Key swatch="bg-primary-400/70" label="speaking" />}
                {stallTimestamps.length > 0 && <Key swatch="bg-amber-400" label="stalled over 2.5s" />}
                {hasGaze && (
                    <>
                        <Key swatch="bg-emerald-400/60" label="facing camera" />
                        <Key swatch="bg-rose-400/60" label="looking away" />
                    </>
                )}
                {hasAffect && <Key swatch="bg-accent-400" label="expression, warmer above the line" />}
            </div>
        </figure>
    );
}

function Key({ swatch, label }: { swatch: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-[1px] ${swatch}`} />
            {label}
        </span>
    );
}

export function formatClock(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
