/**
 * Strict RFC 3339 date-time parser.
 *
 * Accepts `2024-01-15T10:00:00Z`, lowercase `t`/`z`, fractional seconds of
 * any length (truncated to millisecond precision), and numeric offsets
 * `+HH:MM`/`-HH:MM`. An offset is required: a bare local date-time cannot be
 * placed on a global timeline without guessing a timezone. Leap seconds
 * (`:60`) are rejected. Instants whose UTC normalization falls outside years
 * 0000-9999 are rejected too, because the report renders timestamps with
 * Date#toISOString, which only produces RFC 3339 form inside that range.
 *
 * Implemented with positional character parsing and civil-date arithmetic
 * rather than a regex + Date: this runs once per input line, and avoiding the
 * match-array and Date allocations is a measurable share of parse throughput.
 */

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Parse two digits at position i, or -1 if not digits. Comparisons are
 * written to fail on NaN, so reads past the end of the string reject cleanly.
 */
function two(s: string, i: number): number {
  const a = s.charCodeAt(i) - 48;
  const b = s.charCodeAt(i + 1) - 48;
  if (!(a >= 0 && a <= 9 && b >= 0 && b <= 9)) return -1;
  return a * 10 + b;
}

/** Parse to epoch milliseconds (UTC), or null if invalid. */
export function parseRfc3339(value: string): number | null {
  // Shortest valid form: YYYY-MM-DDTHH:MM:SSZ (20 chars).
  if (value.length < 20) return null;

  const yearHi = two(value, 0);
  const yearLo = two(value, 2);
  if (yearHi < 0 || yearLo < 0 || value.charCodeAt(4) !== 0x2d) return null;
  const year = yearHi * 100 + yearLo;
  const month = two(value, 5);
  if (month < 1 || month > 12 || value.charCodeAt(7) !== 0x2d) return null;
  const day = two(value, 8);
  const maxDay = (DAYS_IN_MONTH[month - 1] as number) + (month === 2 && isLeapYear(year) ? 1 : 0);
  if (day < 1 || day > maxDay) return null;

  const sep = value.charCodeAt(10);
  if (sep !== 0x54 && sep !== 0x74) return null; // T | t
  const hour = two(value, 11);
  if (hour < 0 || hour > 23 || value.charCodeAt(13) !== 0x3a) return null;
  const minute = two(value, 14);
  if (minute < 0 || minute > 59 || value.charCodeAt(16) !== 0x3a) return null;
  const second = two(value, 17);
  if (second < 0 || second > 59) return null;

  let i = 19;
  let ms = 0;
  if (value.charCodeAt(i) === 0x2e) {
    // Fractional seconds: RFC 3339 allows any number of digits; truncated to
    // milliseconds.
    i++;
    const start = i;
    let scale = 100;
    while (i < value.length) {
      const d = value.charCodeAt(i) - 48;
      if (!(d >= 0 && d <= 9)) break;
      if (i - start < 3) {
        ms += d * scale;
        scale /= 10;
      }
      i++;
    }
    if (i === start) return null;
  }

  let offsetMinutes = 0;
  const oc = value.charCodeAt(i);
  if (oc === 0x5a || oc === 0x7a) {
    // Z | z
    i++;
  } else if (oc === 0x2b || oc === 0x2d) {
    // +HH:MM | -HH:MM
    const offH = two(value, i + 1);
    if (offH < 0 || offH > 23 || value.charCodeAt(i + 3) !== 0x3a) return null;
    const offM = two(value, i + 4);
    if (offM < 0 || offM > 59) return null;
    offsetMinutes = (offH * 60 + offM) * (oc === 0x2d ? -1 : 1);
    i += 6;
  } else {
    return null;
  }
  if (i !== value.length) return null;

  const epochMs =
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    ms -
    offsetMinutes * 60_000;
  if (epochMs < MIN_EPOCH_MS || epochMs > MAX_EPOCH_MS) return null;
  return epochMs;
}

/** 0000-01-01T00:00:00.000Z, the earliest instant the report can render. */
const MIN_EPOCH_MS = -62_167_219_200_000;
/** 9999-12-31T23:59:59.999Z, the latest instant the report can render. */
const MAX_EPOCH_MS = 253_402_300_799_999;
