"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "./AnswerRibbon";
import { cx } from "@/components/ui";

/**
 * Video/audio answer recorder.
 *
 * Two things here are load-bearing rather than nice-to-have:
 *
 * PREFLIGHT IS NOT OPTIONAL. The dominant failure mode in every video-interview
 * product is discovering, after a three-minute take, that the microphone was on
 * the wrong device. Fifteen seconds of camera/mic/level/face checks eliminates
 * it entirely.
 *
 * FACE ANALYSIS RUNS HERE, IN THE BROWSER. MediaPipe's FaceLandmarker produces
 * blendshapes and a head transform per frame in WASM without a GPU. The frames
 * never leave the device — only a compact numeric track does. That is
 * simultaneously the cheapest option (no GPU on the server), the most private,
 * and the only one that can show framing feedback WHILE recording rather than
 * after.
 *
 * The honest limitation: a client-computed signal is spoofable. This is a
 * practice tool whose output is private to the same person recording, so
 * forging it means lying to yourself. These signals are NOT proctoring-grade
 * and must never be repurposed as such.
 */

type Phase = "idle" | "preflight" | "ready" | "countdown" | "recording" | "review";

export type RecordedTake = {
    blob: Blob;
    mimeType: string;
    durationSeconds: number;
    faceTrack: FaceRow[];
};

type FaceRow = {
    t: number;
    present: boolean;
    yaw: number;
    pitch: number;
    roll: number;
    bbox: [number, number, number, number];
    bs: Record<string, number>;
};

const FACE_SAMPLE_HZ = 15;
const MAX_SECONDS = 300;

export default function Recorder({
    mode,
    targetSeconds,
    onComplete,
    disabled,
}: {
    mode: "VIDEO" | "AUDIO";
    targetSeconds: number;
    onComplete: (take: RecordedTake) => void;
    disabled?: boolean;
}) {
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [countdown, setCountdown] = useState(3);
    const [level, setLevel] = useState(0);
    const [faceOk, setFaceOk] = useState<boolean | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [faceTrackingAvailable, setFaceTrackingAvailable] = useState(true);

    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const faceTrackRef = useRef<FaceRow[]>([]);
    const landmarkerRef = useRef<any>(null);
    // Two separate loops run during preflight — the mic level meter and the face
    // sampler. They had a single shared rAF handle, so each overwrote the
    // other's: stopEverything() could only cancel whichever wrote last, and a
    // second preflight left the first face loop running. Two loops calling
    // detectForVideo on one landmarker produce interleaved timestamps, and
    // MediaPipe's VIDEO mode throws when timestamps aren't strictly increasing.
    const levelRafRef = useRef<number | null>(null);
    const faceRafRef = useRef<number | null>(null);
    // MediaPipe requires a strictly increasing timestamp per detectForVideo call.
    const lastDetectTsRef = useRef(0);
    const detectFailuresRef = useRef(0);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const startedAtRef = useRef<number>(0);
    const takeRef = useRef<RecordedTake | null>(null);

    const stopEverything = useCallback(() => {
        for (const ref of [levelRafRef, faceRafRef]) {
            if (ref.current) cancelAnimationFrame(ref.current);
            ref.current = null;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        // Free the WASM graph rather than leaking it across remounts.
        try {
            landmarkerRef.current?.close?.();
        } catch {
            /* already torn down */
        }
        landmarkerRef.current = null;
    }, []);

    useEffect(() => () => stopEverything(), [stopEverything]);

    /** Ask for devices and start the live preview + level meter + face check. */
    async function startPreflight() {
        setError(null);
        setPhase("preflight");
        try {
            // Release any previous stream first, or a re-run leaves the old
            // camera track live and the indicator light on.
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: mode === "VIDEO" ? { width: 1280, height: 720, facingMode: "user" } : false,
            });
            streamRef.current = stream;
            if (videoRef.current && mode === "VIDEO") {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => {});
            }
            startLevelMeter(stream);
            if (mode === "VIDEO") await startFaceTracking();
            setPhase("ready");
        } catch (e: any) {
            setError(
                e?.name === "NotAllowedError"
                    ? "Your browser blocked camera or microphone access. Allow it in the address bar, then check again."
                    : "Couldn't reach your camera or microphone. Check nothing else is using them, then try again."
            );
            setPhase("idle");
        }
    }

    function startLevelMeter(stream: MediaStream) {
        // Same reason as sampleFaceLoop: a second preflight must not leave two
        // meters running against two AudioContexts.
        if (levelRafRef.current !== null) {
            cancelAnimationFrame(levelRafRef.current);
            levelRafRef.current = null;
        }
        audioCtxRef.current?.close().catch(() => {});

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        // The meter is a 24px bar. Re-rendering the recorder 60 times a second
        // to move it by a sub-pixel is pure waste, so quantise the value and
        // only set state when the rendered width would actually change.
        let lastStep = -1;
        const tick = () => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
            const step = Math.round(peak * 40);
            if (step !== lastStep) {
                lastStep = step;
                setLevel(step / 40);
            }
            levelRafRef.current = requestAnimationFrame(tick);
        };
        tick();
    }

    async function startFaceTracking() {
        // A second preflight must not build a second landmarker over the top of
        // the first — that is how two detect loops end up sharing one graph.
        if (landmarkerRef.current) {
            sampleFaceLoop();
            return;
        }
        try {
            // Loaded at runtime so a CDN hiccup degrades the feature instead of
            // breaking the page bundle. Without it, the answer still records and
            // still scores — presence simply isn't measured, and scoring.py drops
            // an absent dimension rather than scoring it zero.
            const vision = await import(
                /* webpackIgnore: true */
                // @ts-expect-error -- resolved at runtime from the CDN
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"
            );
            const fileset = await vision.FilesetResolver.forVisionTasks(
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
            );
            landmarkerRef.current = await vision.FaceLandmarker.createFromOptions(fileset, {
                baseOptions: {
                    modelAssetPath:
                        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                },
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
                runningMode: "VIDEO",
                numFaces: 1,
            });
            sampleFaceLoop();
        } catch {
            setFaceTrackingAvailable(false);
            setFaceOk(null);
        }
    }

    function sampleFaceLoop() {
        // Never run two of these at once — see the note on faceRafRef.
        if (faceRafRef.current !== null) return;
        let lastSample = 0;
        let lastVideoTime = -1;

        const loop = () => {
            const landmarker = landmarkerRef.current;
            const video = videoRef.current;

            // readyState >= 2 says a frame is decodable, but NOT that dimensions
            // are known. MediaPipe throws on a zero-sized frame, so check the
            // thing we actually depend on.
            const usable =
                landmarker && video && video.readyState >= 2 &&
                video.videoWidth > 0 && video.videoHeight > 0 && !video.paused;

            if (usable) {
                const now = performance.now();
                // TWO gates, and the currentTime one is the load-bearing half.
                //
                // requestAnimationFrame fires at display rate (~60Hz) while the
                // camera decodes at ~30fps, so a wall-clock throttle alone will
                // happily hand MediaPipe the SAME decoded frame more than once —
                // which is what makes detectForVideo throw. Gating on
                // video.currentTime advancing is the pattern the MediaPipe docs
                // specify, and it is the actual fix; the rate limit below it is
                // only there to keep the sample rate near FACE_SAMPLE_HZ.
                if (video.currentTime !== lastVideoTime && now - lastSample >= 1000 / FACE_SAMPLE_HZ) {
                    lastVideoTime = video.currentTime;
                    lastSample = now;
                    // Strictly increasing, always. performance.now() is monotonic
                    // but browsers clamp its precision (Firefox's timer-precision
                    // setting, any non-cross-origin-isolated context), so two
                    // calls can report the same value — which MediaPipe rejects.
                    const ts = Math.max(now, lastDetectTsRef.current + 1);
                    lastDetectTsRef.current = ts;

                    try {
                        const result = landmarker.detectForVideo(video, ts);
                        // Preflight has no recording start yet, so anchor the
                        // timestamp at 0 rather than at process uptime.
                        const elapsed = startedAtRef.current
                            ? (now - startedAtRef.current) / 1000
                            : 0;
                        const row = toFaceRow(result, elapsed);
                        // Only re-render when the answer actually changes.
                        // Setting this every sample re-rendered the whole
                        // recorder 15 times a second to redraw one tick mark.
                        setFaceOk((prev) => (prev === row.present ? prev : row.present));
                        detectFailuresRef.current = 0;
                        // Only accumulate while actually recording; preflight
                        // samples exist to give live feedback, not to be scored.
                        if (recorderRef.current?.state === "recording") faceTrackRef.current.push(row);
                    } catch (err) {
                        // One dropped frame is normal and not worth surfacing.
                        // A persistent failure is a broken graph — stop hammering
                        // it at 60fps and fall back, which costs the candidate
                        // only the presence metrics.
                        if (++detectFailuresRef.current >= 15) {
                            console.warn("Face tracking disabled after repeated failures:", err);
                            setFaceTrackingAvailable(false);
                            setFaceOk(null);
                            faceRafRef.current = null;
                            return;
                        }
                    }
                }
            }
            faceRafRef.current = requestAnimationFrame(loop);
        };

        faceRafRef.current = requestAnimationFrame(loop);
    }

    function beginCountdown() {
        setPhase("countdown");
        setCountdown(3);
        const id = setInterval(() => {
            setCountdown((c) => {
                if (c <= 1) {
                    clearInterval(id);
                    startRecording();
                    return 0;
                }
                return c - 1;
            });
        }, 1000);
    }

    function startRecording() {
        const stream = streamRef.current;
        if (!stream) return;

        chunksRef.current = [];
        faceTrackRef.current = [];
        startedAtRef.current = performance.now();

        const mimeType = pickMimeType(mode);
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mimeType || "video/webm" });
            const durationSeconds = (performance.now() - startedAtRef.current) / 1000;
            takeRef.current = {
                blob,
                mimeType: mimeType || "video/webm",
                durationSeconds,
                faceTrack: faceTrackRef.current,
            };
            setPreviewUrl(URL.createObjectURL(blob));
            setPhase("review");
        };

        recorder.start(1000);
        setPhase("recording");
        setElapsed(0);
    }

    // Elapsed timer, with a hard ceiling so a forgotten tab can't record forever.
    useEffect(() => {
        if (phase !== "recording") return;
        const id = setInterval(() => {
            setElapsed((e) => {
                if (e + 1 >= MAX_SECONDS) stopRecording();
                return e + 1;
            });
        }, 1000);
        return () => clearInterval(id);
    }, [phase]);

    function stopRecording() {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    }

    function useTake() {
        if (takeRef.current) onComplete(takeRef.current);
    }

    function discardTake() {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        takeRef.current = null;
        setPhase("ready");
    }

    const overTarget = elapsed > targetSeconds;
    // A thin ring around the frame during setup/live phases — quiet by default,
    // brightening for whichever moment actually needs attention. It replaces a
    // flat border with something that reads as "this is live" without adding a
    // fourth new UI element.
    const stageRing =
        phase === "recording"
            ? "ring-2 ring-rose-500/60"
            : phase === "countdown"
              ? "ring-2 ring-primary-400/60"
              : phase === "ready"
                ? "ring-1 ring-primary-400/25"
                : "ring-1 ring-border-default";

    return (
        <div className="rounded-2xl border border-border-default bg-surface-secondary/50 p-4">
            {error && (
                <p className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
                    {error}
                </p>
            )}

            {phase === "idle" && (
                <div className="py-8 text-center">
                    <div
                        aria-hidden="true"
                        className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-border-default bg-surface-tertiary text-content-tertiary"
                    >
                        <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                            {mode === "VIDEO" ? (
                                <path d="M15 8.5l4.2-2.5a1 1 0 0 1 1.5.86v10.28a1 1 0 0 1-1.5.86L15 15.5M5 7h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
                            ) : (
                                <>
                                    <rect x="9" y="3" width="6" height="11" rx="3" />
                                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
                                </>
                            )}
                        </svg>
                    </div>
                    <p className="mb-4 text-sm text-content-secondary">
                        {mode === "VIDEO"
                            ? "We'll check your camera and mic before you start."
                            : "We'll check your mic before you start."}
                    </p>
                    <button
                        onClick={startPreflight}
                        disabled={disabled}
                        className="rounded-xl bg-[image:var(--gradient-primary)] px-6 py-2.5 text-sm font-bold text-white shadow-glow transition-all hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                        Set up {mode === "VIDEO" ? "camera" : "mic"}
                    </button>
                </div>
            )}

            {phase !== "idle" && (
                <>
                    {mode === "VIDEO" && (
                        <div
                            className={cx(
                                "relative overflow-hidden rounded-xl bg-black aspect-video transition-[box-shadow] duration-500",
                                stageRing
                            )}
                        >
                            <video
                                ref={videoRef}
                                muted
                                playsInline
                                className={`h-full w-full object-cover ${phase === "review" ? "hidden" : ""}`}
                                style={{ transform: "scaleX(-1)" }}
                            />
                            {phase === "review" && previewUrl && (
                                <video src={previewUrl} controls className="h-full w-full object-cover" />
                            )}

                            {/* A soft vignette gives the frame a "studio" edge rather
                                than a flat camera-app rectangle — same trick a real
                                interview-room camera light does. */}
                            {phase !== "review" && (
                                <div
                                    aria-hidden="true"
                                    className="pointer-events-none absolute inset-0"
                                    style={{
                                        boxShadow: "inset 0 0 90px 20px rgba(0,0,0,0.45)",
                                    }}
                                />
                            )}

                            {/* Framing guide: eyes about a third down, shoulders in. */}
                            {(phase === "ready" || phase === "recording") && (
                                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                                    <div className="frame-breathe absolute left-1/2 top-[42%] h-[52%] w-[38%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-white/30" />
                                </div>
                            )}

                            {phase === "countdown" && <CountdownRing value={countdown} />}

                            {phase === "recording" && (
                                <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 backdrop-blur-sm">
                                    <span className="rec-dot h-2 w-2 rounded-full bg-rose-500" />
                                    <span className="text-[10px] font-black uppercase tracking-wider text-white/90">
                                        Rec
                                    </span>
                                    <span
                                        className={`text-xs font-bold tabular-nums ${overTarget ? "text-amber-400" : "text-white"}`}
                                    >
                                        {formatClock(elapsed)} / {formatClock(targetSeconds)}
                                    </span>
                                </div>
                            )}

                            {/* A live level readout during recording — reassurance
                                that audio is actually being picked up, without
                                requiring a glance away from the lens. */}
                            {phase === "recording" && <LiveLevelBars level={level} />}
                        </div>
                    )}

                    {/* Preflight readouts. Each one names a thing the person can fix. */}
                    {(phase === "preflight" || phase === "ready") && (
                        <div className="mt-3 space-y-2">
                            <Check
                                ok={level > 0.02}
                                label={level > 0.02 ? "Mic is picking you up" : "Say something to test your mic"}
                            >
                                <LevelMeter level={level} />
                            </Check>

                            {mode === "VIDEO" && faceTrackingAvailable && (
                                <Check
                                    ok={faceOk === true}
                                    label={faceOk ? "You're in frame" : "Center yourself in the oval"}
                                />
                            )}
                            {mode === "VIDEO" && !faceTrackingAvailable && (
                                <p className="text-xs text-content-tertiary">
                                    Framing feedback is unavailable in this browser. Your answer still records and
                                    scores — presence just won't be measured.
                                </p>
                            )}
                        </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        {phase === "ready" && (
                            <>
                                <button
                                    onClick={beginCountdown}
                                    className="rounded-xl bg-[image:var(--gradient-primary)] px-6 py-2.5 text-sm font-bold text-white shadow-glow transition-all hover:-translate-y-px cursor-pointer"
                                >
                                    Start recording
                                </button>
                                <span className="text-xs text-content-tertiary">
                                    Aim for about {formatClock(targetSeconds)}. You can retake as often as you like.
                                </span>
                            </>
                        )}

                        {phase === "recording" && (
                            <button
                                onClick={stopRecording}
                                className="group flex items-center gap-2 rounded-xl border border-border-default bg-surface-card px-6 py-2.5 text-sm font-bold text-content-primary transition-all hover:border-rose-400/40 cursor-pointer"
                            >
                                <span className="h-2.5 w-2.5 rounded-[3px] bg-rose-500 transition-transform group-hover:scale-90" />
                                Stop
                            </button>
                        )}

                        {phase === "review" && (
                            <>
                                <button
                                    onClick={useTake}
                                    className="rounded-xl bg-[image:var(--gradient-primary)] px-6 py-2.5 text-sm font-bold text-white shadow-glow transition-all hover:-translate-y-px cursor-pointer"
                                >
                                    Use this take
                                </button>
                                <button
                                    onClick={discardTake}
                                    className="rounded-xl border border-border-default px-5 py-2.5 text-sm font-bold text-content-secondary transition-all hover:text-content-primary cursor-pointer"
                                >
                                    Record again
                                </button>
                                <span className="text-xs text-content-tertiary tabular-nums">
                                    {formatClock(takeRef.current?.durationSeconds ?? 0)} recorded
                                </span>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * The countdown before recording starts, as a ring draining down rather than a
 * flat number on a dimmed screen. The ring is the same shape the recording
 * indicator will occupy a moment later, so the transition from "about to
 * record" to "recording" reads as one continuous motion.
 */
function CountdownRing({ value }: { value: number }) {
    const r = 44;
    const c = 2 * Math.PI * r;
    // 3 -> 2 -> 1 each get a fresh full ring that drains over one second.
    return (
        <div className="absolute inset-0 grid place-items-center bg-black/55" aria-live="polite">
            <div className="relative grid h-28 w-28 place-items-center">
                <svg viewBox="0 0 96 96" className="absolute inset-0 h-full w-full -rotate-90">
                    <circle cx="48" cy="48" r={r} fill="none" strokeWidth="3" className="stroke-white/15" />
                    <circle
                        key={value}
                        cx="48" cy="48" r={r} fill="none" strokeWidth="3" strokeLinecap="round"
                        className="stroke-primary-400"
                        strokeDasharray={c}
                        style={{
                            // @ts-expect-error -- custom property consumed by the keyframe
                            "--ring-circumference": c,
                            animation: "countdown-ring 1s linear forwards",
                        }}
                    />
                </svg>
                <span className="text-6xl font-black tabular-nums text-white">{value}</span>
            </div>
        </div>
    );
}

/** Five bars reacting to live mic level during recording — confirms audio is
 *  being captured without asking anyone to look away from the lens. */
function LiveLevelBars({ level }: { level: number }) {
    const bars = [0.5, 0.8, 1, 0.75, 0.55];
    return (
        <div
            className="absolute bottom-3 right-3 flex h-5 items-end gap-[3px] rounded-md bg-black/50 px-2 py-1 backdrop-blur-sm"
            aria-hidden="true"
        >
            {bars.map((mult, i) => {
                const active = level * 3.2 * mult > 0.15 + i * 0.08;
                return (
                    <span
                        key={i}
                        className={cx(
                            "w-0.75 rounded-full transition-all duration-100",
                            active ? "bg-emerald-400" : "bg-white/25"
                        )}
                        style={{ height: `${30 + mult * 60}%` }}
                    />
                );
            })}
        </div>
    );
}

/** The preflight mic-level bar, extracted so it can be reused without
 *  duplicating the width math. */
function LevelMeter({ level }: { level: number }) {
    return (
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-tertiary">
            <div
                className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
                style={{ width: `${Math.min(100, level * 180)}%` }}
            />
        </div>
    );
}

function Check({ ok, label, children }: { ok: boolean; label: string; children?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2.5 text-xs">
            <span
                className={`grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold ${
                    ok ? "bg-emerald-500/20 text-emerald-400" : "bg-surface-tertiary text-content-tertiary"
                }`}
            >
                {ok ? "✓" : "•"}
            </span>
            <span className={ok ? "text-content-secondary" : "text-content-tertiary"}>{label}</span>
            {children}
        </div>
    );
}

/** Pick a container the browser will actually produce. Safari and Chrome differ. */
function pickMimeType(mode: "VIDEO" | "AUDIO"): string {
    const candidates =
        mode === "VIDEO"
            ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
            : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const type of candidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
}

/**
 * Reduce one MediaPipe result to a track row.
 *
 * Note what is extracted and what is not: head orientation, bounding box, and a
 * handful of named blendshapes. No emotion label is derived here, and none may
 * be downstream — inferring emotional state in an employment context is
 * prohibited under Article 5 of the EU AI Act, and the science behind it is
 * contested besides. We report observable behaviour: where the head pointed,
 * whether the face was in frame, how much the expression moved.
 */
function toFaceRow(result: any, t: number): FaceRow {
    const empty: FaceRow = {
        t: round2(t), present: false, yaw: 0, pitch: 0, roll: 0,
        bbox: [0, 0, 0, 0], bs: {},
    };

    const landmarks = result?.faceLandmarks?.[0];
    if (!landmarks || landmarks.length === 0) return empty;

    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of landmarks) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }

    const matrix: number[] | undefined = result?.facialTransformationMatrixes?.[0]?.data;
    let yaw = 0, pitch = 0, roll = 0;
    if (matrix && matrix.length >= 11) {
        // Column-major 4x4 rotation -> Euler degrees.
        yaw = Math.atan2(-matrix[2], Math.hypot(matrix[6], matrix[10])) * (180 / Math.PI);
        pitch = Math.atan2(matrix[6], matrix[10]) * (180 / Math.PI);
        roll = Math.atan2(matrix[1], matrix[0]) * (180 / Math.PI);
    }

    const shapes: Record<string, number> = {};
    for (const c of result?.faceBlendshapes?.[0]?.categories ?? []) {
        shapes[c.categoryName] = c.score;
    }

    return {
        t: round2(t),
        present: true,
        yaw: round2(yaw),
        pitch: round2(pitch),
        roll: round2(roll),
        bbox: [round3(minX), round3(minY), round3(maxX - minX), round3(maxY - minY)],
        // The blendshapes below are the ones valence-arousal estimation needs,
        // chosen for their FACS action units rather than for looking complete:
        //   smile        AU12 lip corner puller     positive valence
        //   cheekSquint  AU6  cheek raiser          Duchenne marker — separates
        //                                           a felt smile from a polite one
        //   frown        AU15 lip corner depressor  negative valence
        //   browDown     AU4  brow lowerer          negative valence
        //   noseSneer    AU9  nose wrinkler         negative valence
        //   mouthPress   AU24 lip pressor           tension
        //   browInnerUp  AU1  inner brow raiser     arousal
        //   browOuterUp  AU2  outer brow raiser     arousal
        //   eyeWide      AU5  upper lid raiser      arousal
        //   jawOpen      AU26 jaw drop              arousal
        // Eleven numbers per frame, ~15/s — still a small payload, and the
        // server discards the per-frame rows after aggregating them.
        bs: {
            smile: round3(pair(shapes.mouthSmileLeft, shapes.mouthSmileRight)),
            cheekSquint: round3(pair(shapes.cheekSquintLeft, shapes.cheekSquintRight)),
            frown: round3(pair(shapes.mouthFrownLeft, shapes.mouthFrownRight)),
            browDown: round3(pair(shapes.browDownLeft, shapes.browDownRight)),
            noseSneer: round3(pair(shapes.noseSneerLeft, shapes.noseSneerRight)),
            mouthPress: round3(pair(shapes.mouthPressLeft, shapes.mouthPressRight)),
            browInnerUp: round3(shapes.browInnerUp ?? 0),
            browOuterUp: round3(pair(shapes.browOuterUpLeft, shapes.browOuterUpRight)),
            eyeWide: round3(pair(shapes.eyeWideLeft, shapes.eyeWideRight)),
            jawOpen: round3(shapes.jawOpen ?? 0),
            blink: round3(pair(shapes.eyeBlinkLeft, shapes.eyeBlinkRight)),
        },
    };
}

/** Mean of a left/right blendshape pair, treating a missing side as 0. */
function pair(left?: number, right?: number): number {
    return ((left ?? 0) + (right ?? 0)) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
