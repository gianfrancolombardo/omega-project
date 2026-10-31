import { after } from "next/server";

export type DeferFn = (task: () => void | Promise<void>) => void | Promise<void>;

export function runNow(task: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(task()).then(() => undefined);
}

export function scheduleAfterResponse(task: () => void | Promise<void>): void {
  try {
    after(task);
  } catch {
    void Promise.resolve().then(task);
  }
}

export async function awaitDefer(defer: DeferFn, task: () => void | Promise<void>): Promise<void> {
  await Promise.resolve(defer(task));
}
