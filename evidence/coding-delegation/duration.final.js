const UNIT_SECONDS = {
  h: 3600,
  m: 60,
  s: 1,
};

const SEGMENT_RE = /^(\d+)([hms])$/;

/**
 * Parse a duration string such as "1h 30m 15s" into a total number of seconds.
 *
 * A duration is one or more `<number><unit>` segments separated by whitespace.
 * Supported units: `h` (hours), `m` (minutes), `s` (seconds).
 *
 * @param {string} input
 * @returns {number} total seconds
 * @throws {TypeError} when the input is not a string
 * @throws {Error} when the input is empty or malformed
 */
export function parseDuration(input) {
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Invalid duration: empty input");
  }

  const segments = trimmed.split(/\s+/);
  let totalSeconds = 0;

  for (const segment of segments) {
    const match = SEGMENT_RE.exec(segment);
    if (!match) {
      throw new Error(`Invalid duration segment: ${segment}`);
    }

    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Invalid number in duration segment: ${segment}`);
    }

    totalSeconds += value * UNIT_SECONDS[match[2]];
    if (!Number.isSafeInteger(totalSeconds)) {
      throw new Error(`Duration is too large: ${input}`);
    }
  }

  return totalSeconds;
}