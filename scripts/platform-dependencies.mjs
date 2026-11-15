/** Platform payloads stay outside the portable bundle; npm installs the locked target payload. */
export function platformDependencies(lock) {
  const result = {};
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry.dev || !entry.optional || !(entry.os || entry.cpu || entry.libc)) continue;
    const alias = location.slice(location.lastIndexOf("node_modules/") + 13);
    const value = entry.name && entry.name !== alias ? `npm:${entry.name}@${entry.version}` : entry.version;
    if (result[alias] && result[alias] !== value) throw Error(`Conflicting platform dependency ${alias}`);
    result[alias] = value;
  }
  return result;
}
