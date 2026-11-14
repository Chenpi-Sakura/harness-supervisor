import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { WorkerFilters, defaultNavigationFilter } from "./WorkerFilters";
import { navigationDirection } from "./navigation-direction";
import { UiIcon } from "./UiIcon";
import React, { useId, useMemo, useState, useLayoutEffect, useRef } from "react";
import { HarnessIcon } from "./harness-icons";
import { directoryGroupExpanded, directoryGroupKey, groupWorkersByFolder, ownerGroupKey } from "./worker-groups";

export interface NavigationWorker {
  id: string;
  name?: string;
  ownerRef?: string;
  runtime: string;
  persistence?: string;
  status: string;
  cwd: string;
  promptPreview: string;
  updatedAt: string;
  sessionTitle?: string;
}

function statusLabel(status: string) {
  return ({ starting: "启动中", running: "正在工作", awaiting_input: "等待输入", completed: "已完成", failed: "失败", cancelled: "已取消", crashed: "进程异常", orphaned: "失去控制", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}

function harnessName(runtime: string) {
  return ({ pi: "Pi", qoder: "Qoder", mcode: "MiniMax Code", dsh: "DeepSeek Harness" } as Record<string, string>)[runtime] ?? runtime;
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Chevron({ open }: { open: boolean }) {
  return <UiIcon name="chevronRight" size={14} className={open ? "expanded" : ""} />;
}

export function WorkerNavigation({ workers, selected, onSelect, preferredOwnerRef, onProjectSelect, onSessionSelect, activeProjectCwd, activeOwnerRef }: {
  workers: NavigationWorker[];
  selected: string | null;
  onSelect: (id: string) => void;
  activeProjectCwd?: string;
  activeOwnerRef?: string;
  onProjectSelect?: (cwd: string, direction: -1 | 1) => void;
  onSessionSelect?: (cwd: string, ownerRef: string | undefined, direction: -1 | 1) => void;
  preferredOwnerRef?: string;
}) {
  const reduceMotion = useReducedMotion();
  const fade = { opacity: { duration: reduceMotion ? 0 : .1 }, layout: { duration: reduceMotion ? 0 : .22, ease: [.2,.7,.2,1] as const } };
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const [filters, setFilters] = useState(defaultNavigationFilter);
  const filtering = search || Object.values(filters).some(value => value !== "all");
  const visibleWorkers = useMemo(() => workers.filter(worker => {
    const working = ["starting", "running", "awaiting_input"].includes(worker.status);
    return (!search || [worker.name, worker.id, worker.sessionTitle, worker.ownerRef, worker.runtime, worker.cwd, worker.promptPreview].some(value => value?.toLocaleLowerCase().includes(search)))
      && (filters.runtime === "all" || worker.runtime === filters.runtime)
      && (filters.persistence === "all" || (worker.persistence ?? "oneshot") === filters.persistence)
      && (filters.status === "all" || (filters.status === "active" ? working : filters.status === "terminal" ? !working : worker.status === filters.status));
  }), [workers, search, filters]);
  const [grouped, setGrouped] = useState(true);
  const results = useRef<HTMLDivElement>(null);
  const previousGrouped = useRef(grouped);
  useLayoutEffect(() => {
    if (previousGrouped.current === grouped) return;
    previousGrouped.current = grouped;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = results.current?.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" });
    return () => animation?.cancel();
  }, [grouped]);
  const [directoryOverrides, setDirectoryOverrides] = useState<Map<string, boolean>>(new Map());
  const [ownerOverrides, setOwnerOverrides] = useState<Map<string, boolean>>(new Map());
  const groups = useMemo(() => groupWorkersByFolder(visibleWorkers, preferredOwnerRef), [visibleWorkers, preferredOwnerRef]);
  const id = useId();
  const allGroups = useMemo(() => groupWorkersByFolder(workers, preferredOwnerRef), [workers, preferredOwnerRef]);
  const directionFor = (cwd: string, owner?: string): -1 | 1 => navigationDirection(allGroups, activeProjectCwd, activeOwnerRef, cwd, owner);
  const card = (worker: NavigationWorker) => <motion.button layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} key={worker.id} className={`worker-card brand-${worker.runtime} ${selected === worker.id ? "selected" : ""}`} onClick={() => {
    const directoryKey = directoryGroupKey(worker.cwd);
    const ownerKey = JSON.stringify([directoryKey, ownerGroupKey(worker.ownerRef)]);
    // Keep the selected Worker's ancestors open, including after flat view.
    setDirectoryOverrides(previous => new Map(previous).set(directoryKey, true));
    setOwnerOverrides(previous => new Map(previous).set(ownerKey, true));
    onSessionSelect?.(worker.cwd, worker.ownerRef, directionFor(worker.cwd, worker.ownerRef));
    onSelect(worker.id);
  }} aria-pressed={selected === worker.id}>
    <div className="worker-top"><span className="runtime"><HarnessIcon runtime={worker.runtime} />{harnessName(worker.runtime)}</span><span className={`status-dot ${worker.status}`} aria-label={statusLabel(worker.status)} title={statusLabel(worker.status)} /></div>
    <strong>{worker.name ?? worker.id}</strong><p>{worker.promptPreview}</p><small>{statusLabel(worker.status)}<span aria-hidden="true"> · </span>{time(worker.updatedAt)}</small>
  </motion.button>;
  return <>
    <div className="navigation-search"><UiIcon name="search" size={16} /><input type="search" aria-label="搜索会话与 Worker" placeholder="搜索会话、Worker 或目录" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清空搜索" onClick={() => setQuery("")}><UiIcon name="close" size={14} /></button>}</div>
    <p className="navigation-search-count" aria-live="polite">{filtering ? visibleWorkers.length ? `${visibleWorkers.length} 个匹配 Worker` : "没有匹配的会话或 Worker" : ""}</p>
    <div className="navigation-controls"><div className="list-controls" aria-label="任务列表视图"><button aria-pressed={grouped} onClick={() => setGrouped(true)}>按目录</button><button aria-pressed={!grouped} onClick={() => setGrouped(false)}>平铺</button></div><WorkerFilters value={filters} onChange={setFilters} runtimes={[...new Set(workers.map(worker => worker.runtime))]} /></div>
    {preferredOwnerRef && !workers.some(worker => worker.ownerRef === preferredOwnerRef) && <p className="owner-empty">当前会话暂无 Worker，可展开其他文件夹查看。</p>}
    <div className="navigation-results" ref={results}>{grouped ? <div className="folder-groups"><AnimatePresence initial={false} mode="popLayout">{groups.map((directory, directoryIndex) => {
      const open = Boolean(filtering) || directoryGroupExpanded(directory, preferredOwnerRef, directoryOverrides);
      const panelId = `${id}-folder-${directoryIndex}`;
      const name = directory.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? directory.cwd;
      return <motion.section layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className={`directory-group folder-group${directory.current ? " current-directory" : ""}`} key={directory.key}>
        <button className="directory-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => { setDirectoryOverrides(previous => new Map(previous).set(directory.key, !open)); onProjectSelect?.(directory.cwd, directionFor(directory.cwd, directory.owners[0]?.ownerRef)); }}>
          <Chevron open={open} /><strong>{name}</strong><span>{directory.workers.length}</span>
        </button>
        <div className="directory-body" id={panelId} data-open={open} inert={!open} aria-hidden={!open}><div className="directory-content"><AnimatePresence initial={false} mode="popLayout">{directory.owners.map((owner, ownerIndex) => {
          // The same conversation can be independently collapsed in each cwd.
          const ownerKey = JSON.stringify([directory.key, owner.key]);
          const ownerOpen = Boolean(filtering) || (ownerOverrides.get(ownerKey) ?? (!preferredOwnerRef || owner.current));
          const ownerPanelId = `${panelId}-owner-${ownerIndex}`;
          return <motion.section layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className={`owner-group${owner.current ? " current-owner" : ""}`} key={owner.key}>
            <button className="owner-toggle" aria-expanded={ownerOpen} aria-controls={ownerPanelId} title={directory.cwd} aria-description={directory.cwd} onClick={() => { setOwnerOverrides(previous => new Map(previous).set(ownerKey, !ownerOpen)); onSessionSelect?.(directory.cwd, owner.ownerRef, directionFor(directory.cwd, owner.ownerRef)); }}>
              <Chevron open={ownerOpen} /><strong>{owner.workers[0]?.sessionTitle ?? owner.label}</strong><span>{owner.workers.length}</span>
            </button>
            <div className="owner-body" id={ownerPanelId} data-open={ownerOpen} inert={!ownerOpen} aria-hidden={!ownerOpen}><div className="worker-list"><AnimatePresence initial={false} mode="popLayout">{owner.workers.map(card)}</AnimatePresence></div></div>
          </motion.section>;
        })}</AnimatePresence></div></div>
      </motion.section>;
    })}</AnimatePresence></div> : <div className="worker-list"><AnimatePresence initial={false} mode="popLayout">{visibleWorkers.map(card)}</AnimatePresence></div>}</div>
  </>;
}
