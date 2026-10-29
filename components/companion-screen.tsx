"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { attachCharlaSession, type CharlaView, type ScreenPhase } from "@/components/charla-engine";
import { idleLabel } from "@/lib/copy";

const STATE_ID: Record<ScreenPhase, string> = {
  idle: "reposo",
  inviting: "invitacion",
  connecting: "conectando",
  listening: "escuchando",
  thinking: "pensando",
  speaking: "hablando",
  problem: "problema",
};

const EMPTY: CharlaView = {
  phase: "connecting",
  status: "Conectando…",
  subtitle: "",
  problem: null,
  needsGesture: false,
  clock: "",
  dateLabel: "",
};

function previewView(preview: string | undefined, name: string): CharlaView {
  const phase = previewPhase(preview);
  const who = name.trim() || "Elena";
  const status =
    phase === "problem"
      ? "Falta la clave de OpenAI. Quien configura Charla tiene que cargar OPENAI_API_KEY en el servidor."
      : phase === "inviting"
        ? `${who}, buen día. ¿Charlamos un rato?`
        : phase === "listening"
          ? "Te escucho…"
          : phase === "thinking"
            ? "Pensando…"
            : phase === "speaking"
              ? "Hablando…"
              : phase === "connecting"
                ? "Conectando…"
                : idleLabel("vos");
  return {
    phase,
    status,
    subtitle: phase === "speaking" ? "Hoy el cielo está lindo para recordar la rambla." : "",
    problem: phase === "problem" ? status : null,
    needsGesture: false,
    clock: "11:00",
    dateLabel: "Jueves 29 de octubre",
  };
}

function previewPhase(value: string | undefined): ScreenPhase {
  if (value === "escuchando") return "listening";
  if (value === "pensando") return "thinking";
  if (value === "hablando") return "speaking";
  if (value === "problema") return "problem";
  if (value === "invitacion") return "inviting";
  if (value === "conectando") return "connecting";
  return "idle";
}

export function CompanionScreen(props: { mode: "live" | "preview"; preview?: string; previewName?: string }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [live, setLive] = useState<CharlaView>(EMPTY);
  const shown = props.mode === "preview" ? previewView(props.preview, props.previewName ?? "") : live;

  useEffect(() => {
    if (props.mode !== "live") return;
    const root = rootRef.current;
    const audio = audioRef.current;
    if (!root || !audio) return;
    return attachCharlaSession(root, audio, setLive, () => router.push("/setup"));
  }, [props.mode, router]);

  return (
    <div className="charla-screen" data-state={STATE_ID[shown.phase]}>
      <div
        ref={rootRef}
        className="charla-hit"
        role="button"
        tabIndex={0}
        aria-label={shown.status}
      >
        <div className="charla-clock" data-clock>
          <div>{shown.clock}</div>
          <div className="charla-date">{shown.dateLabel}</div>
        </div>
        <div className="charla-orb" aria-hidden="true">
          <p className="charla-status">{shown.phase === "problem" ? "Atención" : shown.status}</p>
        </div>
        {shown.phase === "problem" ? <p className="charla-problem">{shown.status}</p> : null}
        {shown.subtitle ? (
          <p className="charla-sub" aria-live="polite">
            {shown.subtitle}
          </p>
        ) : (
          <p className="charla-sub charla-sub-empty" aria-hidden="true" />
        )}
      </div>
      <audio ref={audioRef} autoPlay playsInline className="charla-audio" />
    </div>
  );
}
