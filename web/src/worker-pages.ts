export interface WorkerListRow {
  id: string;
  createdAt: string;
  ownerRef?: string;
}

export interface WorkerListPage<T extends WorkerListRow> {
  workers: T[];
  preferredWorkers?: T[];
  hasMore: boolean;
}

export interface WorkerListCursor { id: string; createdAt: string }

/** Supplementary current-session workers never participate in the global cursor. */
export function workerPageCursor<T extends WorkerListRow>(page: WorkerListPage<T>): WorkerListCursor | undefined {
  const last = page.workers.at(-1);
  return last ? { id: last.id, createdAt: last.createdAt } : undefined;
}

export function mergeWorkerLists<T extends WorkerListRow>(primary: T[], supplementary: T[] = []): T[] {
  const rows = new Map<string, T>();
  for (const worker of [...primary, ...supplementary]) if (!rows.has(worker.id)) rows.set(worker.id, worker);
  return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function mergeWorkerPages<T extends WorkerListRow>(pages: WorkerListPage<T>[]) {
  const last = pages.at(-1);
  return {
    workers: mergeWorkerLists(pages.flatMap(page => page.workers), pages[0]?.preferredWorkers),
    cursor: last ? workerPageCursor(last) : undefined,
    hasMore: last?.hasMore ?? false,
  };
}

export function chooseWorkerSelection<T extends WorkerListRow>(workers: T[], previous: string | null, preferredOwnerRef?: string): string | null {
  if (previous && workers.some(worker => worker.id === previous)) return previous;
  if (preferredOwnerRef) return workers.find(worker => worker.ownerRef === preferredOwnerRef)?.id ?? null;
  return workers[0]?.id ?? null;
}
