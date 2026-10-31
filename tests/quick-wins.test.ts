import { describe, expect, it } from "vitest";

import { transcriptionHint } from "@/lib/openai/asr";
import { openerKindFor, isSafeThread } from "@/lib/session/opener";
import { threeLowMoodDays } from "@/lib/safety/phq";
import { formatDayContext, dayPartFromHour } from "@/lib/time";
import { spokenCheckin, CHECKIN_ITEMS } from "@/lib/session/instruments";
import { handleSetupPut } from "@/lib/http/setup-api";
import type { MoodSignal } from "@/lib/domain";
import { depsFor, memoryDb, pinHeaders } from "./helpers";

describe("quick wins extras", () => {
  it("keeps ASR hints short and splits openers", () => {
    const hint = transcriptionHint({
      displayName: "Elena",
      importantPeople: "Lucía, Rosa",
      tastes: "tango de Troilo y la rambla de Ramírez",
      lifeNotes: "Creció en Pocitos y después se fue al Cerro",
    });
    expect(hint).toContain("Elena");
    expect(hint.length).toBeLessThanOrEqual(200);
    const kinds = new Set(Array.from({ length: 20 }, (_, index) => openerKindFor(`session-${index}`)));
    expect(kinds.has("thread")).toBe(true);
    expect(kinds.has("today")).toBe(true);
    expect(isSafeThread("la rambla de ayer")).toBe(true);
    expect(isSafeThread("la muerte de su marido")).toBe(false);
    expect(isSafeThread("el hospital")).toBe(false);
    expect(dayPartFromHour(8)).toBe("mañana");
    expect(dayPartFromHour(15)).toBe("tarde");
    expect(dayPartFromHour(21)).toBe("noche");
    expect(formatDayContext(new Date("2026-10-29T14:00:00.000Z"), "America/Montevideo")).toContain("mañana");
    const phq = CHECKIN_ITEMS.find((item) => item.instrument === "phq2");
    expect(phq && spokenCheckin(phq, "vos")).toContain("dos");
  });

  it("flags three low daily mood days in a row", () => {
    const day = (iso: string, score: number): MoodSignal => ({
      id: iso,
      sessionId: iso,
      instrument: "daily",
      itemId: "daily_mood",
      rawAnswer: "",
      score,
      note: "",
      createdAt: iso,
    });
    expect(
      threeLowMoodDays([
        day("2026-10-27T12:00:00.000Z", 2),
        day("2026-10-28T12:00:00.000Z", 1),
        day("2026-10-29T12:00:00.000Z", 2),
      ]),
    ).toBe(true);
    expect(
      threeLowMoodDays([
        day("2026-10-27T12:00:00.000Z", 2),
        day("2026-10-28T12:00:00.000Z", 3),
        day("2026-10-29T12:00:00.000Z", 2),
      ]),
    ).toBe(false);
  });

  it("lets setup decline memory without asking the older person", async () => {
    const { store, close } = await memoryDb();
    const deps = depsFor(store);
    const declined = await handleSetupPut(deps, pinHeaders(), {
      displayName: "Elena",
      rememberEnabled: false,
    });
    expect(declined.status).toBe(200);
    expect((await store.getProfile()).memoryDeclinedAt).toBeTruthy();
    const enabled = await handleSetupPut(deps, pinHeaders(), { rememberEnabled: true });
    expect(enabled.status).toBe(200);
    expect((await store.getProfile()).memoryDeclinedAt).toBeNull();
    close();
  });

  it("drops stale microgoals and does not forget the latest fact blindly", async () => {
    const { store, close } = await memoryDb();
    const recent = await store.addMicrogoal("Llamar hoy", null);
    expect((await store.listOpenMicrogoals()).map((item) => item.id)).toContain(recent.id);
    await store.bumpMicrogoalFollowup(recent.id);
    await store.bumpMicrogoalFollowup(recent.id);
    expect((await store.listOpenMicrogoals()).map((item) => item.id)).not.toContain(recent.id);
    await store.addFact({ category: "gusto", content: "Le gusta el tango" });
    expect(await store.forgetFact("ultimo")).toBeNull();
    expect(await store.listFacts()).toHaveLength(1);
    close();
  });
});
