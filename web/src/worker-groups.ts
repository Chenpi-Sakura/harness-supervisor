export interface OwnedWorker { ownerRef?: string }
export interface DirectoryWorker { cwd: string }

export interface OwnerGroup<T extends OwnedWorker> {
  key: string;
  ownerRef?: string;
  label: string;
  current: boolean;
  workers: T[];
}

export interface DirectoryGroup<T extends DirectoryWorker> {
  key: string;
  cwd: string;
  workers: T[];
}

export interface FolderGroup<T extends OwnedWorker & DirectoryWorker> extends DirectoryGroup<T> {
  current: boolean;
  owners: OwnerGroup<T>[];
}

export function ownerGroupKey(ownerRef?: string): string {
  return ownerRef ? `owner:${ownerRef}` : "unowned";
}

function shortOwnerRef(ownerRef: string): string {
  return ownerRef.length > 20 ? `${ownerRef.slice(0, 12)}…${ownerRef.slice(-4)}` : ownerRef;
}

export function groupWorkersByOwner<T extends OwnedWorker>(workers: T[], preferredOwnerRef?: string): OwnerGroup<T>[] {
  const groups = new Map<string, OwnerGroup<T>>();
  const add = (ownerRef?: string) => {
    const key = ownerGroupKey(ownerRef);
    let group = groups.get(key);
    if (!group) {
      const current = !!preferredOwnerRef && ownerRef === preferredOwnerRef;
      group = { key, ownerRef, current, label: current ? "当前会话" : ownerRef ? `会话 ${shortOwnerRef(ownerRef)}` : "未归属 / 外部任务", workers: [] };
      groups.set(key, group);
    }
    return group;
  };
  // Keep a visible current-session section even before it has any Workers.
  if (preferredOwnerRef) add(preferredOwnerRef);
  for (const worker of workers) add(worker.ownerRef || undefined).workers.push(worker);
  return [...groups.values()];
}

export function ownerGroupExpanded(key: string, preferredOwnerRef: string | undefined, overrides: ReadonlyMap<string, boolean>): boolean {
  const overridden = overrides.get(key);
  return overridden ?? (!preferredOwnerRef || key === ownerGroupKey(preferredOwnerRef));
}

export function directoryGroupKey(cwd: string): string {
  // Preserve the existing Windows drive/UNC normalization and POSIX case rules.
  return /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") ? cwd.replaceAll("/", "\\").toLowerCase() : cwd;
}

export function groupWorkersByDirectory<T extends DirectoryWorker>(workers: T[]): DirectoryGroup<T>[] {
  const groups = new Map<string, DirectoryGroup<T>>();
  for (const worker of workers) {
    const key = directoryGroupKey(worker.cwd);
    const group = groups.get(key) ?? { key, cwd: worker.cwd, workers: [] };
    group.workers.push(worker);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function groupWorkersByFolder<T extends OwnedWorker & DirectoryWorker>(workers: T[], preferredOwnerRef?: string): FolderGroup<T>[] {
  const groups = groupWorkersByDirectory(workers).map(directory => {
    const current = !!preferredOwnerRef && directory.workers.some(worker => worker.ownerRef === preferredOwnerRef);
    return {
      ...directory,
      current,
      // Only pass the preference when this folder actually contains that
      // session. The legacy owner helper also supports an empty current group.
      owners: groupWorkersByOwner(directory.workers, current ? preferredOwnerRef : undefined),
    };
  });
  // Retain the existing order within both sections as pages are appended.
  return [...groups.filter(group => group.current), ...groups.filter(group => !group.current)];
}

export function directoryGroupExpanded(group: { key: string; current: boolean }, preferredOwnerRef: string | undefined, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(group.key) ?? (!preferredOwnerRef || group.current);
}

export function workerTone(id: string): number {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (hash >>> 0) % 6;
}
