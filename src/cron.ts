/** A five-field cron expression (minute hour day-of-month month day-of-week), matched minute by minute. */
export type Cron = { source: string; matches(date: Date): boolean };

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const parseField = (text: string, { name, min, max }: (typeof FIELDS)[number]) => {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!match) throw new Error(`Invalid cron ${name}: ${part}`);
    const [, range, from, to, step] = match;
    const start = range === "*" ? min : Number(from);
    const end = range === "*" ? max : to !== undefined ? Number(to) : step ? max : start;
    const every = step ? Number(step) : 1;
    if (start < min || end > max || start > end || every < 1) throw new Error(`Cron ${name} out of range: ${part}`);
    for (let value = start; value <= end; value += every) values.add(value);
  }
  return values;
};

/** The wall-clock fields of `date` in a time zone (the process's own when omitted). */
const wallClock = (date: Date, timeZone?: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
  };
};

export const parseCron = (expression: string, timeZone?: string): Cron => {
  const source = expression.trim();
  const fields = (ALIASES[source] ?? source).split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron needs five fields (minute hour day month weekday): ${source}`);
  const [minutes, hours, days, months, weekdays] = fields.map((field, index) => parseField(field, FIELDS[index]!));
  // 7 is Sunday too.
  if (weekdays!.has(7)) weekdays!.add(0);
  const anyDay = fields[2] === "*";
  const anyWeekday = fields[4] === "*";
  // Validate the zone now rather than on the first tick.
  wallClock(new Date(), timeZone);
  return {
    source,
    matches(date) {
      const now = wallClock(date, timeZone);
      if (!minutes!.has(now.minute) || !hours!.has(now.hour) || !months!.has(now.month)) return false;
      // Standard cron: when both day fields are restricted, either may match.
      if (anyDay || anyWeekday) return days!.has(now.day) && weekdays!.has(now.weekday);
      return days!.has(now.day) || weekdays!.has(now.weekday);
    },
  };
};
