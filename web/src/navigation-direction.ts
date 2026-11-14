/** Direction follows the visible folder/session ordering, never an unrelated owner's identity. */
export function navigationDirection(
  groups: { cwd: string; owners: { ownerRef?: string }[] }[],
  currentCwd: string | undefined, currentOwner: string | undefined,
  targetCwd: string, targetOwner?: string,
): -1 | 1 {
  const from = Math.max(0, groups.findIndex(group => group.cwd === currentCwd));
  const to = groups.findIndex(group => group.cwd === targetCwd);
  if (to < 0) return -1;
  if (to !== from) return to > from ? -1 : 1;
  const owners = groups[from]?.owners ?? [];
  const fromOwner = Math.max(0, owners.findIndex(owner => (owner.ownerRef ?? "") === (currentOwner ?? "")));
  const toOwner = Math.max(0, owners.findIndex(owner => (owner.ownerRef ?? "") === (targetOwner ?? "")));
  return toOwner >= fromOwner ? -1 : 1;
}
