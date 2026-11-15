import type { MasterContext } from "../../src/ipc/protocol";
import { directoryGroupKey } from "./worker-groups";

interface LayoutWorker { id: string; cwd: string; ownerRef?: string; status: string }
const active = new Set(["running", "starting", "awaiting_input"]);

export function selectRelationProject<T extends LayoutWorker>(workers: T[], masters: MasterContext[], requestedProject?: string, preferredOwnerRef?: string) {
  const masterByOwner = new Map(masters.map(master => [master.ownerRef, master]));
  const project = requestedProject ?? workers.find(worker => worker.ownerRef === preferredOwnerRef)?.cwd
    ?? masterByOwner.get(preferredOwnerRef ?? "")?.cwd ?? workers[0]?.cwd ?? masters.find(master => master.cwd)?.cwd ?? "";
  const key = directoryGroupKey(project);
  const projectWorkers = workers.filter(worker => directoryGroupKey(worker.cwd) === key);
  const owners = [...new Set([
    ...projectWorkers.map(worker => worker.ownerRef).filter((value): value is string => Boolean(value)),
    ...masters.filter(master => master.cwd && directoryGroupKey(master.cwd) === key).map(master => master.ownerRef),
  ])];
  return { project, projectWorkers, owners, masterByOwner };
}

export function layoutRelationWorkers<T extends LayoutWorker>(projectWorkers: T[], owners: string[], scope: "session" | "project", owner: string, filter: string) {
  const originalsByOwner = new Map<string, T[]>();
  const membersByOwner = new Map<string, T[]>();
  for (const worker of projectWorkers) {
    const key = worker.ownerRef ?? "";
    const originals = originalsByOwner.get(key) ?? [];
    originals.push(worker);
    originalsByOwner.set(key, originals);
  }
  const sessionWorkers = scope === "project" ? projectWorkers : originalsByOwner.get(owner) ?? [];
  const visible = sessionWorkers.filter(worker => filter === "all" || (filter === "active" ? active.has(worker.status) : !active.has(worker.status)));
  for (const worker of visible) {
    const key = worker.ownerRef ?? "";
    const members = membersByOwner.get(key) ?? [];
    members.push(worker);
    membersByOwner.set(key, members);
  }
  const groupOwners = scope === "project" ? [...new Set([...originalsByOwner.keys(), ...owners])] : [owner];
  const positionsByWorker = new Map<string, { x: number; y: number; masterX: number; masterY: number }>();
  let nextX = 0;
  const groups = groupOwners.map((groupOwner, index) => {
    const originals = originalsByOwner.get(groupOwner) ?? [];
    const members = membersByOwner.get(groupOwner) ?? [];
    const rowCount = Math.max(1, Math.ceil(Math.sqrt(members.length / 2)));
    const weights = Array.from({ length: rowCount }, (_, row) => row + 2);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let remaining = members.length;
    const rowSizes = weights.map((weight, row) => {
      const count = row === rowCount - 1 ? remaining : Math.min(remaining, Math.max(1, Math.floor(members.length * weight / totalWeight)));
      remaining -= count;
      return count;
    });
    const innerWidth = Math.max(284, Math.max(...rowSizes) * 320 - 36);
    const padding = scope === "project" ? 32 : 0;
    const top = scope === "project" ? 70 : 0;
    const x = nextX;
    const width = innerWidth + padding * 2;
    const height = top + 300 + rowCount * 284 + padding;
    const masterX = x + width / 2 - 142;
    const points = rowSizes.flatMap((count, row) => Array.from({ length: count }, (_, column) => ({
      x: x + padding + (innerWidth - (count * 320 - 36)) / 2 + column * 320,
      y: top + 300 + row * 284,
    })));
    members.forEach((worker, memberIndex) => positionsByWorker.set(worker.id, { ...points[memberIndex]!, masterX, masterY: top }));
    let running = 0, terminal = 0, awaitingInput = false;
    for (const worker of originals) {
      if (worker.status === "starting" || worker.status === "running") running++;
      if (!active.has(worker.status)) terminal++;
      if (worker.status === "awaiting_input") awaitingInput = true;
    }
    nextX += width + 48;
    return { owner: groupOwner, originals, members, points, x, width, height, masterX, masterY: top, index, state: running > terminal ? "running" : awaitingInput && !terminal ? "awaiting_input" : "completed" };
  });
  return {
    sessionWorkers, visible, groups,
    width: Math.max(284, nextX - 48),
    height: Math.max(584, ...groups.map(group => group.height)),
    positions: visible.map(worker => positionsByWorker.get(worker.id)!),
    working: sessionWorkers.filter(worker => worker.status === "running" || worker.status === "starting").length,
  };
}
