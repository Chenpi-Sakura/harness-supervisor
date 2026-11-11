import React, { useId, useMemo, useState } from "react";
import { HarnessIcon } from "./harness-icons";
import { directoryGroupExpanded, directoryGroupKey, groupWorkersByFolder, ownerGroupKey, workerTone } from "./worker-groups";

export interface NavigationWorker {
  id: string;
  name?: string;
  ownerRef?: string;
  runtime: string;
  status: string;
  cwd: string;
  promptPreview: string;
  updatedAt: string;
}

function statusLabel(status: string) {
  return ({ starting: "启动中", running: "执行中", awaiting_input: "等待输入", completed: "已完成", failed: "失败", cancelled: "已取消", crashed: "进程异常", orphaned: "失去控制", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}

function harnessName(runtime: string) {
  return ({ pi: "Pi", qoder: "Qoder", mcode: "MiniMax Code", dsh: "DSH" } as Record<string, string>)[runtime] ?? runtime;
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Chevron({ open }: { open: boolean }) {
  return <svg aria-hidden="true" className={open ? "expanded" : ""} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 4 4 4-4 4" /></svg>;
}

export function WorkerNavigation({ workers, selected, onSelect, preferredOwnerRef }: {
  workers: NavigationWorker[];
  selected: string | null;
  onSelect: (id: string) => void;
  preferredOwnerRef?: string;
}) {
  const [grouped, setGrouped] = useState(true);
  const [directoryOverrides, setDirectoryOverrides] = useState<Map<string, boolean>>(new Map());
  const [ownerOverrides, setOwnerOverrides] = useState<Map<string, boolean>>(new Map());
  const groups = useMemo(() => groupWorkersByFolder(workers, preferredOwnerRef), [workers, preferredOwnerRef]);
  const id = useId();
  const card = (worker: NavigationWorker) => <button key={worker.id} className={`worker-card worker-tone-${workerTone(worker.id)} ${selected === worker.id ? "selected" : ""}`} onClick={() => {
    const directoryKey = directoryGroupKey(worker.cwd);
    const ownerKey = JSON.stringify([directoryKey, ownerGroupKey(worker.ownerRef)]);
    // Keep the selected Worker's ancestors open, including after flat view.
    setDirectoryOverrides(previous => new Map(previous).set(directoryKey, true));
    setOwnerOverrides(previous => new Map(previous).set(ownerKey, true));
    onSelect(worker.id);
  }} aria-pressed={selected === worker.id}>
    <div className="worker-top"><span className="runtime"><HarnessIcon runtime={worker.runtime} />{harnessName(worker.runtime)}</span><span className={`status-dot ${worker.status}`} aria-label={statusLabel(worker.status)} title={statusLabel(worker.status)} /></div>
    <strong>{worker.name ?? worker.id}</strong><p>{worker.promptPreview}</p><small>{statusLabel(worker.status)}<span aria-hidden="true"> · </span>{time(worker.updatedAt)}</small>
  </button>;
  return <>
    <div className="list-controls" aria-label="任务列表视图"><button aria-pressed={grouped} onClick={() => setGrouped(true)}>按目录</button><button aria-pressed={!grouped} onClick={() => setGrouped(false)}>平铺</button></div>
    {preferredOwnerRef && !workers.some(worker => worker.ownerRef === preferredOwnerRef) && <p className="owner-empty">当前会话暂无 Worker，可展开其他文件夹查看。</p>}
    {grouped ? <div className="folder-groups">{groups.map((directory, directoryIndex) => {
      const open = directoryGroupExpanded(directory, preferredOwnerRef, directoryOverrides);
      const panelId = `${id}-folder-${directoryIndex}`;
      const name = directory.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? directory.cwd;
      return <section className={`directory-group folder-group${directory.current ? " current-directory" : ""}`} key={directory.key}>
        <button className="directory-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setDirectoryOverrides(previous => new Map(previous).set(directory.key, !open))}>
          <Chevron open={open} /><strong>{name}</strong><span>{directory.workers.length}</span>
        </button>
        <div className="directory-body" id={panelId} hidden={!open}>{directory.owners.map((owner, ownerIndex) => {
          // The same conversation can be independently collapsed in each cwd.
          const ownerKey = JSON.stringify([directory.key, owner.key]);
          const ownerOpen = ownerOverrides.get(ownerKey) ?? (!preferredOwnerRef || owner.current);
          const ownerPanelId = `${panelId}-owner-${ownerIndex}`;
          return <section className={`owner-group${owner.current ? " current-owner" : ""}`} key={owner.key}>
            <button className="owner-toggle" aria-expanded={ownerOpen} aria-controls={ownerPanelId} title={directory.cwd} aria-description={directory.cwd} onClick={() => setOwnerOverrides(previous => new Map(previous).set(ownerKey, !ownerOpen))}>
              <Chevron open={ownerOpen} /><strong>{owner.label}</strong><span>{owner.workers.length}</span>
            </button>
            <div className="owner-body" id={ownerPanelId} hidden={!ownerOpen}><div className="worker-list">{owner.workers.map(card)}</div></div>
          </section>;
        })}</div>
      </section>;
    })}</div> : <div className="worker-list">{workers.map(card)}</div>}
  </>;
}
