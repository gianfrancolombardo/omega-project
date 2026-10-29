import {
  ACTIVATION_MESSAGE,
  DEVICE_PIN_STORAGE_KEY,
  MISSING_KEY_MESSAGE,
  idleLabel,
  inviteLabel,
  listeningLabel,
} from "@/lib/copy";
import type { AddressForm, SessionInitiator, SessionStatus } from "@/lib/domain";
import type { PublicProfile } from "@/lib/profile-public";
import { responseCreateEvent } from "@/lib/realtime/events";
import { createLiveState, reduceLive, type LiveAction, type LiveContext, type LiveEffect, type LiveState } from "@/lib/realtime/logic";
import { acceptTap } from "@/lib/session/policy";
import { formatClock, formatLongDate } from "@/lib/time";

export type ScreenPhase = "idle" | "inviting" | "connecting" | "listening" | "thinking" | "speaking" | "problem";

export type CharlaView = {
  phase: ScreenPhase;
  status: string;
  subtitle: string;
  problem: string | null;
  needsGesture: boolean;
  clock: string;
  dateLabel: string;
};

const REALTIME_CALLS = "https://api.openai.com/v1/realtime/calls";

type SessionPayload = {
  clientSecret?: string;
  sessionToken?: string;
  greetingCue?: string;
  addressForm?: AddressForm;
  silenceCloseSeconds?: number;
  subtitles?: boolean;
  displayName?: string;
  message?: string;
};

function playChime(): void {
  const context = new AudioContext();
  const start = context.currentTime;
  const notes: Array<[number, number]> = [
    [523.25, 0],
    [659.25, 0.18],
  ];
  for (const [frequency, offset] of notes) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.05, start + offset + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.4);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(start + offset);
    osc.stop(start + offset + 0.42);
  }
  window.setTimeout(() => void context.close(), 1200);
}

async function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => resolve(), 1500);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        resolve();
      }
    });
  });
}

function statusText(input: {
  phase: ScreenPhase;
  form: AddressForm;
  name: string;
  problem: string | null;
  needsGesture: boolean;
}): string {
  if (input.needsGesture && input.phase !== "idle" && input.phase !== "problem") {
    return "Tocá la pantalla para escucharme";
  }
  if (input.phase === "problem") return input.problem || "Hay un problema con la voz.";
  if (input.phase === "inviting") return inviteLabel(input.form, input.name);
  if (input.phase === "connecting") return "Conectando…";
  if (input.phase === "listening") return listeningLabel(input.form);
  if (input.phase === "thinking") return "Pensando…";
  if (input.phase === "speaking") return "Hablando…";
  return idleLabel(input.form);
}

export function attachCharlaSession(
  root: HTMLElement,
  audio: HTMLAudioElement,
  onChange: (view: CharlaView) => void,
  onSetup: () => void,
): () => void {
  let alive = true;
  let phase: ScreenPhase = "connecting";
  let subtitle = "";
  let problem: string | null = null;
  let needsGesture = false;
  let profile: PublicProfile | null = null;
  let showSubtitles = true;
  let clock = "";
  let dateLabel = "";
  const pin = window.localStorage.getItem(DEVICE_PIN_STORAGE_KEY) ?? "";
  let openaiOk = false;
  let live: LiveState | null = null;
  let ctx: LiveContext = { addressForm: "vos", initiator: "user", closeAfterMs: 75_000 };
  let token: string | null = null;
  let greeting = "";
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let stream: MediaStream | null = null;
  let meter: AudioContext | null = null;
  let frame = 0;
  const queue: Record<string, unknown>[] = [];
  let done = false;
  let starting = false;
  let lastTap: number | null = null;
  let pressTimer = 0;
  let longPress = false;
  const timers: number[] = [];

  function view(): CharlaView {
    const form = profile?.addressForm ?? "vos";
    const name = profile?.displayName ?? "";
    return {
      phase,
      status: statusText({ phase, form, name, problem, needsGesture }),
      subtitle: showSubtitles ? subtitle : "",
      problem,
      needsGesture,
      clock,
      dateLabel,
    };
  }

  function publish(): void {
    if (!alive) return;
    onChange(view());
  }

  function setScreen(next: ScreenPhase): void {
    phase = next;
    publish();
  }

  function headers(json = false): HeadersInit {
    const value: Record<string, string> = { "x-setup-pin": pin };
    if (json) value["Content-Type"] = "application/json";
    return value;
  }

  function sendEvent(event: Record<string, unknown>): void {
    if (!channel || channel.readyState !== "open") {
      queue.push(event);
      return;
    }
    channel.send(JSON.stringify(event));
  }

  function disconnect(): void {
    window.cancelAnimationFrame(frame);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    channel = null;
    pc?.close();
    pc = null;
    audio.srcObject = null;
    void meter?.close();
    meter = null;
    queue.length = 0;
  }

  function finish(outcome: SessionStatus, message?: string): void {
    if (done) return;
    done = true;
    const turns = live?.turns ?? [];
    const usageEvents = live?.usageEvents ?? [];
    const userSpoke = live?.userSpoke ?? false;
    const currentToken = token;
    token = null;
    live = null;
    disconnect();
    if (outcome === "error") {
      problem = message ?? "Se cortó la voz. Tocá para intentar de nuevo.";
      subtitle = "";
      setScreen("problem");
    } else {
      problem = null;
      subtitle = "";
      setScreen("idle");
    }
    if (!currentToken) return;
    void fetch("/api/session/end", {
      method: "POST",
      keepalive: true,
      headers: headers(true),
      body: JSON.stringify({ sessionToken: currentToken, outcome, transcript: turns, usageEvents, userSpoke }),
    });
  }

  function applyEffect(effect: LiveEffect): void {
    if (effect.type === "send") {
      sendEvent(effect.event);
      return;
    }
    if (effect.type === "end") {
      finish(effect.outcome);
      return;
    }
    if (effect.type === "tool") {
      void runTool(effect.name, effect.callId, effect.arguments);
      return;
    }
    if (effect.type === "safety") {
      void fetch("/api/safety", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ sessionToken: token, text: effect.text }),
      });
    }
  }

  function dispatch(action: LiveAction): void {
    if (!live || live.ended) return;
    const result = reduceLive(live, action, ctx);
    live = result.state;
    subtitle = result.state.subtitle;
    if (!result.state.ended) setScreen(result.state.phase);
    else publish();
    for (const effect of result.effects) applyEffect(effect);
  }

  async function runTool(name: string, callId: string, args: string): Promise<void> {
    let output = "No pude hacer eso ahora.";
    let hangup: SessionStatus | null = null;
    try {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ sessionToken: token, name, arguments: args }),
      });
      const data = (await response.json()) as { output?: string; hangup?: SessionStatus | null };
      if (typeof data.output === "string") output = data.output;
      if (data.hangup === "declined" || data.hangup === "completed" || data.hangup === "no_response" || data.hangup === "error") {
        hangup = data.hangup;
      }
    } catch {
      output = "No pude guardar eso ahora.";
    }
    dispatch({ type: "tool_result", callId, output, hangup, now: Date.now() });
  }

  function watchLevel(media: MediaStream): void {
    const context = new AudioContext();
    meter = context;
    const source = context.createMediaStreamSource(media);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        energy += centered * centered;
      }
      const level = Math.min(1.08, 1 + Math.sqrt(energy / samples.length) * 0.45);
      document.documentElement.style.setProperty("--listen-level", level.toFixed(3));
      frame = window.requestAnimationFrame(loop);
    };
    loop();
  }

  async function openCall(secret: string): Promise<void> {
    const peer = new RTCPeerConnection();
    pc = peer;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream = media;
    for (const track of media.getTracks()) peer.addTrack(track, media);
    watchLevel(media);
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => {
        needsGesture = true;
        publish();
      });
    };
    const data = peer.createDataChannel("oai-events");
    channel = data;
    data.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as unknown;
        if (!parsed || typeof parsed !== "object") return;
        dispatch({ type: "server", event: parsed as Record<string, unknown>, now: Date.now() });
      } catch {
        return;
      }
    };
    data.onopen = () => {
      const queued = queue.splice(0);
      for (const event of queued) data.send(JSON.stringify(event));
      sendEvent(responseCreateEvent(greeting));
      dispatch({ type: "connected", now: Date.now() });
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIce(peer);
    const answer = await fetch(REALTIME_CALLS, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: peer.localDescription?.sdp ?? "",
    });
    if (!answer.ok) throw new Error("webrtc");
    await peer.setRemoteDescription({ type: "answer", sdp: await answer.text() });
  }

  async function start(initiator: SessionInitiator): Promise<void> {
    if (starting || !pin) return;
    starting = true;
    done = false;
    problem = null;
    subtitle = "";
    setScreen("connecting");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ initiator }),
      });
      const data = (await response.json()) as SessionPayload;
      if (!alive) return;
      if (!response.ok || !data.clientSecret || !data.sessionToken) {
        problem = data.message ?? "No pude empezar la charla.";
        setScreen("problem");
        return;
      }
      token = data.sessionToken;
      greeting = data.greetingCue ?? "";
      showSubtitles = data.subtitles !== false;
      ctx = {
        addressForm: data.addressForm === "usted" ? "usted" : "vos",
        initiator,
        closeAfterMs: (data.silenceCloseSeconds ?? 75) * 1000,
      };
      live = createLiveState(Date.now());
      await openCall(data.clientSecret);
    } catch {
      if (alive) finish("error", "No pude abrir el micrófono o la voz. Revisá el permiso y probá de nuevo.");
    } finally {
      starting = false;
    }
  }

  function activate(): void {
    if (longPress) {
      longPress = false;
      return;
    }
    if (needsGesture) {
      void audio.play().then(() => {
        needsGesture = false;
        publish();
      }).catch(() => undefined);
      return;
    }
    if (phase === "speaking" || phase === "thinking") {
      dispatch({ type: "interrupt", now: Date.now() });
      return;
    }
    if (phase === "listening" || phase === "connecting" || phase === "inviting") return;
    if (!pin) {
      problem = ACTIVATION_MESSAGE;
      setScreen("problem");
      return;
    }
    if (!openaiOk) {
      problem = MISSING_KEY_MESSAGE;
      setScreen("problem");
      return;
    }
    const now = Date.now();
    if (!acceptTap(now, lastTap)) return;
    lastTap = now;
    void start("user");
  }

  function onPointerDown(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("[data-clock]")) return;
    window.clearTimeout(pressTimer);
    longPress = false;
    pressTimer = window.setTimeout(() => {
      longPress = true;
      onSetup();
    }, 5_000);
  }

  function onPointerUp(): void {
    window.clearTimeout(pressTimer);
  }

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  }

  root.addEventListener("click", activate);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("keydown", onKeyDown);

  function tickClock(): void {
    const zone = profile?.timezone || "America/Montevideo";
    const now = new Date();
    clock = formatClock(now, zone);
    dateLabel = formatLongDate(now, zone);
    publish();
  }
  tickClock();
  timers.push(window.setInterval(tickClock, 15_000));
  timers.push(window.setInterval(() => dispatch({ type: "tick", now: Date.now() }), 1_000));

  const onHide = () => {
    if (!token || !live) return;
    const outcome: SessionStatus = live.userSpoke ? "completed" : ctx.initiator === "proactive" ? "no_response" : "accidental";
    finish(outcome);
  };
  window.addEventListener("pagehide", onHide);

  let wakeLock: WakeLockSentinel | null = null;
  const requestLock = () => {
    if (!navigator.wakeLock) return;
    void navigator.wakeLock.request("screen").then((sentinel) => {
      wakeLock = sentinel;
    }).catch(() => undefined);
  };
  requestLock();
  const onVisible = () => {
    if (document.visibilityState === "visible") requestLock();
  };
  document.addEventListener("visibilitychange", onVisible);

  void (async () => {
    if (!pin) {
      problem = ACTIVATION_MESSAGE;
      setScreen("problem");
      return;
    }
    try {
      const healthResponse = await fetch("/api/health");
      const health = (await healthResponse.json()) as { openai?: boolean };
      if (!alive) return;
      openaiOk = Boolean(health.openai);
      const profileResponse = await fetch("/api/profile", { headers: { "x-setup-pin": pin } });
      const profileBody = (await profileResponse.json()) as PublicProfile & { message?: string };
      if (!alive) return;
      if (!profileResponse.ok) {
        problem = profileBody.message ?? "No pude leer la configuración.";
        setScreen("problem");
        return;
      }
      profile = profileBody;
      showSubtitles = profileBody.subtitles !== false;
      if (!health.openai) {
        problem = MISSING_KEY_MESSAGE;
        setScreen("problem");
        return;
      }
      problem = null;
      setScreen("idle");
    } catch {
      if (!alive) return;
      problem = "No pude hablar con Charla. Revisá la conexión.";
      setScreen("problem");
    }
  })();

  const poll = async () => {
    if (!alive) return;
    if (phase === "idle" && pin && openaiOk) {
      try {
        const response = await fetch("/api/proactive", { headers: { "x-setup-pin": pin } });
        const data = (await response.json()) as { shouldStart?: boolean };
        if (alive && data.shouldStart && phase === "idle") {
          setScreen("inviting");
          playChime();
          await new Promise((resolve) => window.setTimeout(resolve, 700));
          if (alive) await start("proactive");
        }
      } catch {
        // The next poll retries. A missed chime is cheaper than a stuck screen.
      }
    }
    if (alive) timers.push(window.setTimeout(() => void poll(), 20_000));
  };
  timers.push(window.setTimeout(() => void poll(), 4_000));

  return () => {
    alive = false;
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisible);
    void wakeLock?.release();
    root.removeEventListener("click", activate);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerUp);
    root.removeEventListener("keydown", onKeyDown);
    window.clearTimeout(pressTimer);
    for (const timer of timers) window.clearTimeout(timer);
    for (const timer of timers) window.clearInterval(timer);
    disconnect();
  };
}
