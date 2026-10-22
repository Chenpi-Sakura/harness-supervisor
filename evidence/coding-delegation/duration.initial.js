export function parseDuration(input) {
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }
  const match = input.trim().match(/^(\d+)([hms])$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }
  const value = Number(match[1]);
  if (match[2] === "h") return value * 3600;
  return value * 60;
}
