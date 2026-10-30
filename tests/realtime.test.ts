import { describe, expect, it } from "vitest";

import {
  createLiveState,
  reduceLive,
  type LiveContext,
} from "@/lib/realtime/logic";
import { cancelResponseEvent } from "@/lib/realtime/events";

const ctx: LiveContext = { addressForm: "vos", initiator: "user", closeAfterMs: 75_000 };

function at(state: ReturnType<typeof createLiveState>, type: string, extra: Record<string, unknown> = {}, now = 1_000) {
  return reduceLive(state, { type: "server", event: { type, ...extra }, now }, ctx);
}

describe("realtime reducer", () => {
  it("follows the voice and forces the emergency script", () => {
    let state = createLiveState(0);
    state = reduceLive(state, { type: "connected", now: 100 }, ctx).state;
    expect(state.phase).toBe("listening");
    state = at(state, "response.created", {}, 200).state;
    state = at(state, "output_audio_buffer.started", {}, 300).state;
    expect(state.agentSpoke).toBe(true);
    const heard = at(state, "conversation.item.input_audio_transcription.completed", { transcript: "Me quiero morir" }, 400);
    expect(heard.effects.some((effect) => effect.type === "safety" && effect.interrupt)).toBe(true);
    expect(JSON.stringify(heard.effects)).toContain("911");
    expect(heard.state.emergency).toBe(true);
    const ordinary = at(state, "conversation.item.input_audio_transcription.completed", { transcript: "Me muero de risa" }, 400);
    expect(ordinary.effects).toEqual([]);
    expect(ordinary.state.turns).toHaveLength(1);
    const liked = at(state, "conversation.item.input_audio_transcription.completed", { transcript: "Me gusta la pizza de muzza" }, 500);
    expect(liked.effects).toEqual([{ type: "memory", text: "Me gusta la pizza de muzza" }]);
    expect(heard.effects.some((effect) => effect.type === "memory")).toBe(false);
  });

  it("closes on silence, dose and interrupt", () => {
    let state = { ...createLiveState(0), phase: "listening" as const, agentSpoke: true };
    const accidental = reduceLive(state, { type: "tick", now: 10_000 }, ctx);
    expect(accidental.state.closing).toBe("accidental");
    const proactive = reduceLive(state, { type: "tick", now: 60_000 }, { ...ctx, initiator: "proactive" });
    expect(proactive.state.closing).toBe("no_response");
    state = { ...state, userSpoke: true };
    expect(reduceLive(state, { type: "tick", now: 20_000 }, ctx).effects[0]).toMatchObject({ type: "send" });
    state = { ...state, promptedStillThere: true, lastActivityAt: 0 };
    expect(reduceLive(state, { type: "tick", now: 75_000 }, ctx).state.closing).toBe("completed");
    const dose = reduceLive({ ...state, lastActivityAt: 15 * 60_000 }, { type: "tick", now: 15 * 60_000 }, ctx);
    expect(dose.state.dose15).toBe(true);
    const speaking = { ...createLiveState(0), phase: "speaking" as const };
    const cut = reduceLive(speaking, { type: "interrupt", now: 50 }, ctx);
    expect(cut.effects[0]).toMatchObject({ type: "send", event: cancelResponseEvent() });
    const closing = reduceLive({ ...speaking, closing: "completed" }, { type: "interrupt", now: 50 }, ctx);
    expect(closing.effects.some((effect) => effect.type === "end")).toBe(true);
    expect(reduceLive(state, { type: "interrupt", now: 10 }, ctx).effects).toEqual([]);
  });

  it("waits for every tool and ends when the audio stops", () => {
    const state = createLiveState(0);
    const first = at(state, "response.function_call_arguments.done", { name: "remember_fact", call_id: "a", arguments: "{\"category\":\"gusto\"}" });
    const second = at(first.state, "response.function_call_arguments.done", { name: "recall_facts", call_id: "b", arguments: {} });
    expect(second.state.pendingCalls).toEqual(["a", "b"]);
    const one = reduceLive(second.state, { type: "tool_result", callId: "a", output: "ok", hangup: null, now: 10 }, ctx);
    expect(one.effects).toHaveLength(1);
    const done = reduceLive(one.state, { type: "tool_result", callId: "b", output: "listo", hangup: "completed", now: 20 }, ctx);
    expect(done.effects).toHaveLength(2);
    expect(done.state.closing).toBe("completed");
    expect(reduceLive(done.state, { type: "tool_result", callId: "b", output: "otra", hangup: null, now: 30 }, ctx).effects).toEqual([]);
    const stopped = at({ ...done.state, playback: true, phase: "speaking" }, "output_audio_buffer.stopped", {}, 40);
    expect(stopped.effects[0]).toMatchObject({ type: "end", outcome: "completed" });
    const hung = reduceLive({ ...createLiveState(0), phase: "connecting" }, { type: "tick", now: 30_000 }, ctx);
    expect(hung.effects[0]).toMatchObject({ type: "end", outcome: "error" });
    const usage = at(createLiveState(0), "response.done", { response: { usage: { input_tokens: 3 } } }, 5);
    expect(usage.state.usageEvents).toHaveLength(1);
    const delta = at(createLiveState(0), "response.output_audio_transcript.delta", { delta: "Hola" });
    const transcript = at(delta.state, "response.output_audio_transcript.done", { transcript: "Hola Elena" });
    expect(transcript.state.turns[0].text).toBe("Hola Elena");
    expect(at(createLiveState(0), "error", { error: { code: "response_cancel_not_active" } }).effects).toEqual([]);
    expect(reduceLive(stopped.state, { type: "tick", now: 99 }, ctx).effects).toEqual([]);
  });
});
