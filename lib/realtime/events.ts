export function responseCreateEvent(instructions?: string): Record<string, unknown> {
  if (!instructions) return { type: "response.create" };
  return { type: "response.create", response: { instructions } };
}

export function functionOutputEvent(callId: string, output: string): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  };
}

export function cancelResponseEvent(): Record<string, unknown> {
  return { type: "response.cancel" };
}

export function clearAudioEvent(): Record<string, unknown> {
  return { type: "output_audio_buffer.clear" };
}

export function systemNoteEvent(text: string): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text }],
    },
  };
}
