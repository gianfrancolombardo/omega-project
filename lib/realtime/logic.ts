import type { AddressForm, SessionInitiator, SessionStatus, TranscriptTurn } from "@/lib/domain";
import {
  accidentalLine,
  exactSpeech,
  proactiveSilenceLine,
  silenceCloseLine,
  stillThereLine,
} from "@/lib/copy";
import { doseNudge, evaluateSilence } from "@/lib/session/policy";
import { assessUtterance, PASSIVE_NOTE, safetyScript, type RiskKind } from "@/lib/safety/assess";
import {
  cancelResponseEvent,
  clearAudioEvent,
  functionOutputEvent,
  responseCreateEvent,
  systemNoteEvent,
} from "@/lib/realtime/events";

export type LivePhase = "connecting" | "listening" | "thinking" | "speaking";

export type LiveState = {
  phase: LivePhase;
  userSpoke: boolean;
  userSpeaking: boolean;
  agentSpoke: boolean;
  promptedStillThere: boolean;
  closing: SessionStatus | null;
  ended: boolean;
  pendingCalls: string[];
  dose15: boolean;
  dose20: boolean;
  turns: TranscriptTurn[];
  usageEvents: unknown[];
  lastActivityAt: number;
  startedAt: number;
  subtitle: string;
  assistantBuffer: string;
  emergency: boolean;
  closeMarkedAt: number | null;
  playback: boolean;
  responseActive: boolean;
  responseHadAudio: boolean;
  pendingScript: string | null;
};

export type LiveEffect =
  | { type: "send"; event: Record<string, unknown> }
  | { type: "tool"; name: string; callId: string; arguments: string; background?: boolean }
  | { type: "safety"; text: string; level: 0 | 2 | 3; interrupt: boolean }
  | { type: "memory"; text: string }
  | { type: "end"; outcome: SessionStatus };

export type LiveContext = {
  addressForm: AddressForm;
  initiator: SessionInitiator;
  closeAfterMs: number;
};

export type LiveAction =
  | { type: "server"; event: Record<string, unknown>; now: number }
  | { type: "tick"; now: number }
  | { type: "interrupt"; now: number }
  | { type: "tool_result"; callId: string; output: string; hangup: SessionStatus | null; now: number }
  | { type: "connected"; now: number };

export const MAX_USER_TURN_MS = 4 * 60_000;
export const EMERGENCY_HOLD_MS = 10 * 60_000;

export const DOSE_SOFT =
  "Sin mencionar minutos ni el reloj: cuando ella termine la idea, proponé seguir mañana y una cosa chica para hacer, mejor si incluye a alguien de su gente. Si quiere seguir, seguí.";
export const DOSE_FIRM =
  "Sin mencionar minutos ni el reloj: despedite con calidez en este turno, proponé seguir mañana y una cosa chica, y llamá end_session, salvo que la persona pida seguir.";

const FIRE_AND_FORGET = new Set(["save_microgoal", "complete_microgoal", "forget_fact"]);

export function createLiveState(now: number): LiveState {
  return {
    phase: "connecting",
    userSpoke: false,
    userSpeaking: false,
    agentSpoke: false,
    promptedStillThere: false,
    closing: null,
    ended: false,
    pendingCalls: [],
    dose15: false,
    dose20: false,
    turns: [],
    usageEvents: [],
    lastActivityAt: now,
    startedAt: now,
    subtitle: "",
    assistantBuffer: "",
    emergency: false,
    closeMarkedAt: null,
    playback: false,
    responseActive: false,
    responseHadAudio: false,
    pendingScript: null,
  };
}

function textOf(event: Record<string, unknown>, key: string): string {
  const value = event[key];
  return typeof value === "string" ? value : "";
}

function pushTurn(state: LiveState, role: "user" | "assistant", text: string, now: number, itemId?: string): LiveState {
  const trimmed = text.trim();
  if (!trimmed) return state;
  const turns = [...state.turns, { role, text: trimmed.slice(0, 4000), at: new Date(now).toISOString(), itemId }];
  return { ...state, turns: turns.slice(-400) };
}

function fillUserTurn(state: LiveState, text: string, now: number, itemId?: string): LiveState {
  const trimmed = text.trim();
  if (!trimmed) return { ...state, userSpoke: true, lastActivityAt: now };
  const turns = [...state.turns];
  let index = itemId ? turns.findIndex((turn) => turn.role === "user" && turn.itemId === itemId) : -1;
  if (index < 0) {
    for (let cursor = turns.length - 1; cursor >= 0; cursor -= 1) {
      if (turns[cursor]?.role === "user" && !turns[cursor].text.trim()) {
        index = cursor;
        break;
      }
    }
  }
  if (index >= 0 && turns[index]) {
    turns[index] = { ...turns[index], text: trimmed.slice(0, 4000) };
    return { ...state, turns, userSpoke: true, lastActivityAt: now };
  }
  return pushTurn({ ...state, userSpoke: true, lastActivityAt: now }, "user", trimmed, now, itemId);
}

function endWith(state: LiveState, outcome: SessionStatus): { state: LiveState; effects: LiveEffect[] } {
  if (state.ended) return { state, effects: [] };
  return {
    state: { ...state, ended: true, closing: outcome, playback: false },
    effects: [{ type: "end", outcome }],
  };
}

function finishAudio(state: LiveState, now: number): { state: LiveState; effects: LiveEffect[] } {
  const next = { ...state, playback: false, phase: "listening" as const, lastActivityAt: now };
  if (state.closing) return endWith(next, state.closing);
  return { state: next, effects: [] };
}

function scripted(state: LiveState, now: number, closing: SessionStatus | null, line: string, prompted = false): {
  state: LiveState;
  effects: LiveEffect[];
} {
  return {
    state: {
      ...state,
      phase: "thinking",
      lastActivityAt: now,
      promptedStillThere: state.promptedStillThere || prompted,
      closing: closing ?? state.closing,
      closeMarkedAt: closing ? now : state.closeMarkedAt,
    },
    effects: [{ type: "send", event: responseCreateEvent(exactSpeech(line)) }],
  };
}

function applyServer(state: LiveState, event: Record<string, unknown>, now: number, ctx: LiveContext): {
  state: LiveState;
  effects: LiveEffect[];
} {
  const type = textOf(event, "type");
  if (type === "error") return { state, effects: [] };

  if (type === "input_audio_buffer.speech_started") {
    return {
      state: { ...state, userSpoke: true, userSpeaking: true, phase: "listening", playback: false, lastActivityAt: now },
      effects: [],
    };
  }

  if (type === "input_audio_buffer.speech_stopped") {
    return { state: { ...state, userSpeaking: false, phase: "thinking", lastActivityAt: now }, effects: [] };
  }

  if (type === "input_audio_buffer.committed") {
    const itemId = textOf(event, "item_id") || textOf(event, "itemId");
    const turn: TranscriptTurn = { role: "user", text: "", at: new Date(now).toISOString(), itemId: itemId || undefined };
    return {
      state: { ...state, turns: [...state.turns, turn].slice(-400), userSpoke: true, lastActivityAt: now },
      effects: [],
    };
  }

  if (type === "conversation.item.input_audio_transcription.delta") {
    return {
      state: { ...state, userSpoke: true, userSpeaking: true, lastActivityAt: now },
      effects: [],
    };
  }

  if (type === "response.created") {
    return {
      state: { ...state, responseActive: true, responseHadAudio: false, phase: "thinking", lastActivityAt: now },
      effects: [],
    };
  }

  if (type === "output_audio_buffer.started" || type === "response.output_audio.delta") {
    return {
      state: {
        ...state,
        phase: "speaking",
        playback: true,
        agentSpoke: true,
        responseHadAudio: true,
        lastActivityAt: now,
      },
      effects: [],
    };
  }

  if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
    return finishAudio(state, now);
  }

  if (type === "response.output_audio.done" && !state.playback) {
    return finishAudio(state, now);
  }

  if (type === "response.output_audio_transcript.delta") {
    const buffer = `${state.assistantBuffer}${textOf(event, "delta")}`;
    return { state: { ...state, assistantBuffer: buffer, subtitle: buffer }, effects: [] };
  }

  if (type === "response.output_audio_transcript.done") {
    const text = textOf(event, "transcript") || state.assistantBuffer;
    const next = pushTurn({ ...state, assistantBuffer: "", subtitle: text }, "assistant", text, now);
    return { state: next, effects: [] };
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = textOf(event, "transcript");
    const itemId = textOf(event, "item_id") || textOf(event, "itemId");
    let next = fillUserTurn({ ...state, userSpeaking: false }, text, now, itemId || undefined);
    const assessment = assessUtterance(text);
    if (assessment.level === 0) {
      return { state: next, effects: [] };
    }
    const effects: LiveEffect[] = [
      { type: "safety", text, level: assessment.level, interrupt: assessment.level === 3 && !state.emergency },
    ];
    if (assessment.level === 2 && assessment.kind === "suicide") {
      effects.push({ type: "send", event: systemNoteEvent(PASSIVE_NOTE) });
      return { state: next, effects };
    }
    if (assessment.level === 3 && !state.emergency) {
      const kind = assessment.kind === "none" ? "emergency" : assessment.kind;
      const scriptKind: Exclude<RiskKind, "none"> = kind === "distress" ? "emergency" : kind;
      const script = safetyScript(scriptKind, ctx.addressForm);
      next = {
        ...next,
        emergency: true,
        phase: "thinking",
        lastActivityAt: now,
        pendingScript: state.responseActive ? script : null,
      };
      effects.push({ type: "send", event: cancelResponseEvent() }, { type: "send", event: clearAudioEvent() });
      if (!state.responseActive) {
        effects.push({ type: "send", event: responseCreateEvent(exactSpeech(script)) });
      }
    }
    return { state: next, effects };
  }

  if (type === "response.function_call_arguments.done") {
    const name = textOf(event, "name");
    const callId = textOf(event, "call_id");
    if (!name || !callId || state.pendingCalls.includes(callId)) return { state, effects: [] };
    const raw = event.arguments;
    const args = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    if (FIRE_AND_FORGET.has(name)) {
      const effects: LiveEffect[] = [
        { type: "tool", name, callId, arguments: args, background: true },
        { type: "send", event: functionOutputEvent(callId, "ok") },
      ];
      if (!state.responseHadAudio) effects.push({ type: "send", event: responseCreateEvent() });
      return { state: { ...state, lastActivityAt: now }, effects };
    }
    return {
      state: { ...state, pendingCalls: [...state.pendingCalls, callId] },
      effects: [{ type: "tool", name, callId, arguments: args }],
    };
  }

  if (type === "response.done") {
    const response = event.response;
    const usage =
      response && typeof response === "object" && "usage" in response
        ? (response as { usage?: unknown }).usage
        : undefined;
    let next: LiveState = {
      ...state,
      responseActive: false,
      usageEvents: usage ? [...state.usageEvents, usage].slice(-200) : state.usageEvents,
    };
    const effects: LiveEffect[] = [];
    if (state.pendingScript) {
      effects.push({ type: "send", event: responseCreateEvent(exactSpeech(state.pendingScript)) });
      next = { ...next, pendingScript: null, phase: "thinking", lastActivityAt: now };
    }
    if (next.closing && !next.playback) return endWith(next, next.closing);
    return { state: next, effects };
  }

  return { state, effects: [] };
}

function applyTick(state: LiveState, now: number, ctx: LiveContext): { state: LiveState; effects: LiveEffect[] } {
  if (state.ended) return { state, effects: [] };
  if (state.emergency) {
    if (state.phase === "listening" && now - state.lastActivityAt >= EMERGENCY_HOLD_MS) {
      return scripted(state, now, "completed", silenceCloseLine(ctx.addressForm));
    }
    return { state, effects: [] };
  }
  if (state.userSpeaking && now - state.lastActivityAt < MAX_USER_TURN_MS) {
    return { state, effects: [] };
  }
  if (state.closing) {
    if (state.phase !== "speaking" && state.closeMarkedAt != null && now - state.closeMarkedAt >= 12_000) {
      return endWith(state, state.closing);
    }
    return { state, effects: [] };
  }

  const silence = evaluateSilence({
    phase: state.phase,
    now,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    userSpoke: state.userSpoke,
    agentSpoke: state.agentSpoke,
    promptedStillThere: state.promptedStillThere,
    closing: false,
    initiator: ctx.initiator,
    closeAfterMs: ctx.closeAfterMs,
  });

  if (silence === "give_up") return endWith(state, "error");
  if (silence === "still_there") return scripted(state, now, null, stillThereLine(ctx.addressForm), true);
  if (silence === "accidental_close") return scripted(state, now, "accidental", accidentalLine(ctx.addressForm));
  if (silence === "no_response") return scripted(state, now, "no_response", proactiveSilenceLine(ctx.addressForm));
  if (silence === "cost_close") return scripted(state, now, "completed", silenceCloseLine(ctx.addressForm));

  if (state.phase !== "listening" || state.userSpeaking) return { state, effects: [] };
  const nudge = doseNudge(now - state.startedAt, { at15: state.dose15, at20: state.dose20 });
  if (nudge === "none") return { state, effects: [] };
  const firm = nudge === "firm";
  return {
    state: {
      ...state,
      dose15: true,
      dose20: state.dose20 || firm,
    },
    effects: [{ type: "send", event: systemNoteEvent(firm ? DOSE_FIRM : DOSE_SOFT) }],
  };
}

export function reduceLive(
  state: LiveState,
  action: LiveAction,
  ctx: LiveContext,
): { state: LiveState; effects: LiveEffect[] } {
  if (state.ended && action.type !== "server") return { state, effects: [] };

  if (action.type === "connected") {
    if (state.phase !== "connecting") return { state, effects: [] };
    return { state: { ...state, phase: "listening", lastActivityAt: action.now }, effects: [] };
  }

  if (action.type === "interrupt") {
    if (state.ended) return { state, effects: [] };
    if (state.phase !== "speaking" && state.phase !== "thinking") return { state, effects: [] };
    if (state.closing) return endWith({ ...state, playback: false }, state.closing);
    return {
      state: {
        ...state,
        phase: "listening",
        playback: false,
        assistantBuffer: "",
        lastActivityAt: action.now,
      },
      effects: [
        { type: "send", event: cancelResponseEvent() },
        { type: "send", event: clearAudioEvent() },
      ],
    };
  }

  if (action.type === "tool_result") {
    if (!state.pendingCalls.includes(action.callId)) return { state, effects: [] };
    const pendingCalls = state.pendingCalls.filter((id) => id !== action.callId);
    let next: LiveState = { ...state, pendingCalls };
    const effects: LiveEffect[] = [{ type: "send", event: functionOutputEvent(action.callId, action.output) }];
    if (action.hangup && !next.closing) {
      next = { ...next, closing: action.hangup, closeMarkedAt: action.now };
    }
    if (pendingCalls.length === 0 && !state.responseHadAudio) {
      effects.push({ type: "send", event: responseCreateEvent() });
      next = { ...next, phase: "thinking", lastActivityAt: action.now };
    }
    return { state: next, effects };
  }

  if (action.type === "tick") return applyTick(state, action.now, ctx);
  return applyServer(state, action.event, action.now, ctx);
}
