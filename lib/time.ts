export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const hour = bag.hour === "24" ? 0 : Number(bag.hour);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

export function localDateString(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function localDateInZone(date: Date, timeZone: string): string {
  return localDateString(zonedParts(date, timeZone));
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const diff = target - asUtc;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

export function dailyInstant(now: Date, timeZone: string, dailyTime: string): Date {
  const parts = zonedParts(now, timeZone);
  const [hourText, minuteText] = dailyTime.split(":");
  return zonedTimeToUtc(
    parts.year,
    parts.month,
    parts.day,
    Number(hourText),
    Number(minuteText),
    timeZone,
  );
}

export function isWithinWindow(now: Date, start: Date, windowMs: number): boolean {
  const time = now.getTime();
  return time >= start.getTime() && time < start.getTime() + windowMs;
}

export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function formatLongDate(date: Date, timeZone: string): string {
  const label = new Intl.DateTimeFormat("es-UY", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export type DayPart = "mañana" | "tarde" | "noche";

export function dayPartFromHour(hour: number): DayPart {
  if (hour < 12) return "mañana";
  if (hour < 19) return "tarde";
  return "noche";
}

export function formatDayContext(date: Date, timeZone: string): string {
  const hour = zonedParts(date, timeZone).hour;
  return `${formatLongDate(date, timeZone)}, ${formatClock(date, timeZone)} (${dayPartFromHour(hour)})`;
}
