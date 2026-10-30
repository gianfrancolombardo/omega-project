export const MAIN_MODULES = ["charla", "mi_historia", "curiosidad", "opinion"] as const;

export type MainModule = (typeof MAIN_MODULES)[number];

export const MODULE_LABELS: Record<MainModule, string> = {
  charla: "Charla",
  mi_historia: "Mi historia",
  curiosidad: "Curiosidad",
  opinion: "Opinión y actualidad",
};

export function isMainModule(value: string): value is MainModule {
  return (MAIN_MODULES as readonly string[]).includes(value);
}
