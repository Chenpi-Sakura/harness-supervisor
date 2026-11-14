import { AnimatePresence, motion, animate as animateValue, useMotionValue, useReducedMotion } from "motion/react";
import { UiIcon } from "./UiIcon";
import React, { useState, useEffect, useRef } from "react";
import { HarnessIcon } from "./harness-icons";
import { Markdown } from "./Markdown";
import "./worker-relations.css";

export interface RelationWorker {
  id: string; name?: string; ownerRef?: string; runtime: string; status: string; model?: string; sessionTitle?: string;
  lifecycle: string; persistence: string; promptPreview: string; cwd: string;
  result?: { text: string; truncated: boolean };
}

export const relationStatus: Record<string, string> = {
  running: "正在工作", starting: "正在启动", awaiting_input: "等待输入", completed: "已完成",
  cancelled: "已取消", failed: "执行失败", crashed: "异常终止", interrupted: "已中断", orphaned: "失去连接",
};
const runtimeNames: Record<string, string> = { pi: "Pi", qoder: "Qoder", mcode: "MiniMax Code", dsh: "DeepSeek Harness", codex: "Codex", claude: "Claude Code" };
const active = new Set(["running", "starting", "awaiting_input"]);

function Frame({ status, persistent }: { status: string; persistent: boolean }) {
  return <svg className="relation-frame" aria-hidden="true" width="100%" height="100%">
    <rect className="relation-frame-base" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="13" pathLength="100" strokeDasharray={persistent ? undefined : "2 1.5"} />
    {["running", "starting", "awaiting_input"].includes(status) && <rect className="relation-frame-motion" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="13" pathLength="100" />}
  </svg>;
}

export function WorkerRelations({ workers, preferredOwnerRef, onOpen, demo = false, displayScope, onScopeChange, onGroupSelect, projectCwd, transitionDirection = -1, selectedOwnerRef, selectedWorkerId, onProjectChange }: {
  workers: RelationWorker[]; onGroupSelect?: (ownerRef: string) => void; displayScope?: "session" | "project"; onScopeChange?: (scope: "session" | "project") => void; transitionDirection?: -1 | 1; selectedWorkerId?: string | null; selectedOwnerRef?: string; projectCwd?: string; onProjectChange?: (cwd: string) => void; preferredOwnerRef?: string; onOpen?: (id: string) => void; demo?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const projects = [...new Set(workers.map(worker => worker.cwd))];
  const [localProject, setLocalProject] = useState<string | null>(null);
  const project = projectCwd ?? localProject ?? workers.find(worker => worker.ownerRef === preferredOwnerRef)?.cwd ?? projects[0] ?? "";
  const projectWorkers = workers.filter(worker => worker.cwd === project);
  const owners = [...new Set(projectWorkers.map(worker => worker.ownerRef).filter((value): value is string => Boolean(value)))];
  const [chosenOwner, setOwner] = useState<string | null>(preferredOwnerRef ?? null);
  const owner = selectedOwnerRef !== undefined && (selectedOwnerRef === "" || owners.includes(selectedOwnerRef)) ? selectedOwnerRef : chosenOwner !== null && (owners.includes(chosenOwner) || chosenOwner === "") ? chosenOwner : owners[0] ?? "";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoomLabel] = useState(1);
  const panX = useMotionValue(0);
  const panY = useMotionValue(0);
  const scaleValue = useMotionValue(1);
  const zoomAnimation = useRef<{ stop: () => void } | null>(null);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  function setZoom(value: number | ((previous: number) => number)) {
    const next = typeof value === "function" ? value(zoomRef.current) : value;
    zoomRef.current = next;
    zoomAnimation.current?.stop();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) scaleValue.set(next);
    else zoomAnimation.current = animateValue(scaleValue, next, { duration: .18, ease: [.2,.7,.2,1] });
    setZoomLabel(next);
  }
  function setOffset(value: { x: number; y: number }) {
    offsetRef.current = value;
    panX.set(value.x); panY.set(value.y);
  }
  const canvasRef = useRef<HTMLDivElement>(null);
  const panMoved = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      setZoom(value => Math.min(1.6, Math.max(.4, value * Math.exp(-delta * .002))));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, []);
  const [localScope, setLocalScope] = useState<"session" | "project">("session");
  const scope = displayScope ?? localScope;
  const setScope = (value: "session" | "project") => { setLocalScope(value); onScopeChange?.(value); };
  const [filter, setFilter] = useState("all");
  useEffect(() => { setSelectedId(null); }, [project, owner]);
  const selected = workers.find(worker => worker.id === selectedId);
  const sessionWorkers = scope === "project" ? projectWorkers : projectWorkers.filter(worker => (worker.ownerRef ?? "") === owner);
  const visible = sessionWorkers.filter(worker => filter === "all" || (filter === "active" ? active.has(worker.status) : !active.has(worker.status)));
  const groupOwners = scope === "project" ? [...new Set(projectWorkers.map(worker => worker.ownerRef ?? ""))] : [owner];
  let nextX = 0;
  const groups = groupOwners.map((groupOwner, index) => {
    const originals = projectWorkers.filter(worker => (worker.ownerRef ?? "") === groupOwner);
    const members = visible.filter(worker => (worker.ownerRef ?? "") === groupOwner);
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
    const points = rowSizes.flatMap((count, row) => Array.from({ length: count }, (_, column) => ({
      x: x + padding + (innerWidth - (count * 320 - 36)) / 2 + column * 320,
      y: top + 300 + row * 284,
    })));
    const running = originals.filter(worker => ["starting", "running"].includes(worker.status)).length;
    const terminal = originals.filter(worker => !active.has(worker.status)).length;
    nextX += width + 48;
    return { owner: groupOwner, originals, members, points, x, width, height, masterX: x + width / 2 - 142, masterY: top, index, state: running > terminal ? "running" : originals.some(worker => worker.status === "awaiting_input") && !terminal ? "awaiting_input" : "completed" };
  });
  const width = Math.max(284, nextX - 48);
  const height = Math.max(584, ...groups.map(group => group.height));
  const positions = visible.map(worker => { const group = groups.find(group => group.members.some(member => member.id === worker.id))!; return { ...group.points[group.members.findIndex(member => member.id === worker.id)]!, masterX: group.masterX, masterY: group.masterY }; });
  const working = sessionWorkers.filter(worker => worker.status === "running" || worker.status === "starting").length;
  return <section className="relations" aria-label="Master 与 Worker 关系" data-direction={transitionDirection} data-project={project} data-owner={owner}>

    <div className="relations-toolbar"><div className="relations-inline-count"><strong>{sessionWorkers.length}</strong> Workers <span>· {working} 个正在工作</span></div><div className="relations-filters" aria-label="Worker 状态筛选">{[["all", "全部"], ["active", "进行中"], ["terminal", "已结束"]].map(([value, title]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{title}</button>)}</div></div>
    <div className={`relations-body${selected ? " has-inspector" : ""}`}>
      <div className="relations-viewport"><div ref={canvasRef} className="relations-canvas" aria-label="委派关系图，可拖动背景平移" onDragStart={event => event.preventDefault()} onClick={event => {
        if (panMoved.current) return;
        const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        if (target?.closest(".relation-worker")) return;
        const group = target?.closest<HTMLElement>("[data-session-group]");
        if (group) { const value = group.dataset.sessionGroup ?? ""; setOwner(value); setScope("session"); onGroupSelect?.(value); }
      }} onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, select, .relation-worker")) return;
        event.preventDefault();
        panMoved.current = false;
        window.getSelection()?.removeAllRanges();
        const element = event.currentTarget; const start = { x: event.clientX - offsetRef.current.x, y: event.clientY - offsetRef.current.y };
        element.setPointerCapture(event.pointerId);
        const origin = { x: event.clientX, y: event.clientY };
        const move = (next: PointerEvent) => { if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) > 4) panMoved.current = true; setOffset({ x: next.clientX - start.x, y: next.clientY - start.y }); };
        const end = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", end); };
        element.addEventListener("pointermove", move); element.addEventListener("pointerup", end); element.addEventListener("pointercancel", end);
      }}>
        <motion.div className="relations-stage" style={{ width, height, x: panX, y: panY, scale: scaleValue }}><AnimatePresence mode="wait" initial={false} custom={transitionDirection} onExitComplete={() => { setOffset({ x: 0, y: 0 }); setZoom(1); if (canvasRef.current) canvasRef.current.scrollTop = 0; }}><motion.div key={`${project}:${scope === "project" ? "project" : owner}:${scope}`} className="relations-scene" custom={transitionDirection} variants={{ enter: (direction: number) => ({ opacity: 1, y: reduceMotion ? 0 : -direction * (height + (canvasRef.current?.clientHeight ?? 800) + Math.abs(offsetRef.current.y) / zoomRef.current + 100) }), visible: { opacity: 1, y: 0 }, leave: (direction: number) => ({ opacity: 1, y: reduceMotion ? 0 : direction * (height + (canvasRef.current?.clientHeight ?? 800) + Math.abs(offsetRef.current.y) / zoomRef.current + 100) }) }} initial="enter" animate="visible" exit="leave" transition={{ duration: reduceMotion ? 0 : .32, ease: [.4, 0, .2, 1] }}>
          {scope === "project" && groups.map(group => <motion.div layout="position" layoutDependency={`${group.x}:${group.width}:${group.height}`} key={group.owner} data-session-group={group.owner} role="button" tabIndex={0} aria-label={`进入会话 ${group.originals[0]?.sessionTitle ?? group.owner}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOwner(group.owner); setScope("session"); onGroupSelect?.(group.owner); } }} className={`session-boundary group-state-${group.state}`} style={{ left: group.x, top: 0, width: group.width, height: group.height, "--group-tint": ["#6584ff", "#ba8aff", "#65c6aa", "#d5a761"][group.index % 4] } as React.CSSProperties}><Frame status={group.state === "running" ? "running" : "master"} persistent /><h3>{group.originals[0]?.sessionTitle ?? (group.owner || "未归属记录")}</h3></motion.div>)}
          {groups.map(group => (<motion.article key={group.owner} layoutDependency={width} layout="position" transition={{ layout: { duration: reduceMotion ? 0 : .28 } }} className={`relation-worker relation-master ${demo ? "state-running" : ""} ${demo ? "brand-dsh" : "brand-generic"}`} style={{ left: group.masterX, top: group.masterY }}>
            <Frame status={demo ? "running" : "master"} persistent />
            <div className="relation-node-top"><span className="relation-brand-mark"><HarnessIcon runtime={demo ? "dsh" : "unknown"} size={24} /></span><span>{demo ? "DeepSeek Harness" : "Harness 未上报"}</span><small>MASTER</small></div>
            <h3>{demo ? group.originals[0]?.sessionTitle ?? project.split(/[\\/]/).filter(Boolean).at(-1) ?? "项目协作" : "Master 会话"}</h3>
            <div className="relation-model"><span>{demo ? "MiniMax-M3.1-Flash（演示）" : "型号未上报"}</span></div>
            <p className="relation-master-directory" title={demo ? project : undefined}>{demo ? project : "工作目录未上报"}</p>
            <footer>{demo ? <span className="relation-state state-running"><i />正在工作</span> : <span>来源会话</span>}</footer>
          </motion.article>))}
          {<>
            {<svg className="relation-edges" width={width} height={height} aria-hidden="true">{visible.map((worker, index) => {
              const x = positions[index]!.x + 142; const y = positions[index]!.y;
              const source = positions[index]!; const startX = source.masterX + 142; const startY = source.masterY + 234;
              const bend = (startY + y) / 2;
              return <motion.path initial={false} animate={{ d: `M ${startX} ${startY} C ${startX} ${bend}, ${x} ${bend}, ${x} ${y}` }} transition={{ duration: reduceMotion ? 0 : .28, ease: [.2,.7,.2,1] }} key={worker.id} className={`relation-edge state-${worker.status}`} d={`M ${startX} ${startY} C ${startX} ${bend}, ${x} ${bend}, ${x} ${y}`} />;
            })}</svg>}
            <AnimatePresence mode="popLayout" initial={false}>{visible.map((worker, index) => <motion.button layoutDependency={`${positions[index]!.x}:${positions[index]!.y}:${width}`} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ layout: { duration: reduceMotion ? 0 : .28, ease: [.2,.7,.2,1] }, opacity: { duration: reduceMotion ? 0 : .1 } }} key={worker.id} data-worker-id={worker.id} className={`relation-worker brand-${worker.runtime} state-${worker.status}${(selectedWorkerId ?? selectedId) === worker.id ? " is-selected" : ""}`} style={{ left: positions[index]!.x, top: positions[index]!.y }} onClick={() => { if (onOpen) onOpen(worker.id); else setSelectedId(worker.id); }} aria-pressed={(selectedWorkerId ?? selectedId) === worker.id}>
              <Frame status={worker.status} persistent={worker.persistence === "persistent"} />
              <div className="relation-node-top"><span className="relation-brand-mark"><HarnessIcon runtime={worker.runtime} size={24} /></span><span>{runtimeNames[worker.runtime] ?? worker.runtime}</span><small>{worker.persistence === "persistent" ? "持久会话" : "一次性任务"}</small></div>
              <h3>{worker.name ?? worker.id}</h3><div className="relation-model" title={worker.model}><span>{worker.model ?? "型号未上报"}</span></div><p className="relation-task">{worker.promptPreview}</p>
              <footer><span className="relation-state"><i />{relationStatus[worker.status] ?? worker.status}</span><span>{worker.persistence === "persistent" && worker.lifecycle === "idle" ? "可续接" : <>查看详情 <UiIcon name="arrowUpRight" size={14} /></>}</span></footer>
            </motion.button>)}</AnimatePresence>
          </>}
        </motion.div></AnimatePresence></motion.div>
        {!visible.length && <p className="relations-no-workers">当前筛选下暂无 Worker</p>}
        </div><div className="relations-scope" aria-label="显示范围">{[["session", "会话"], ["project", "项目"]].map(([value, title]) => <button key={value} aria-pressed={scope === value} onClick={() => setScope(value as "session" | "project")}>{title}</button>)}</div><div className="relations-zoom"><button aria-label="缩小关系图" onClick={() => setZoom(value => Math.max(.4, value - .1))}><UiIcon name="minus" size={16} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大关系图" onClick={() => setZoom(value => Math.min(1.6, value + .1))}><UiIcon name="plus" size={16} /></button><button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>复位</button></div>
      </div>
      {selected && <aside className="relations-inspector" aria-label="所选 Worker"><div className="relations-inspector-head"><span>WORKER 详情</span><button aria-label="关闭 Worker 详情" onClick={() => setSelectedId(null)}><UiIcon name="close" /></button></div><HarnessIcon runtime={selected.runtime} size={24} /><h3>{selected.name ?? selected.id}</h3><span className={`relation-state state-${selected.status}`}><i />{relationStatus[selected.status] ?? selected.status}</span><dl><div><dt>Harness</dt><dd>{runtimeNames[selected.runtime] ?? selected.runtime}</dd></div><div><dt>LLM</dt><dd>{selected.model ?? "型号未上报"}</dd></div><div><dt>会话类型</dt><dd>{selected.persistence === "persistent" ? "持久会话 · 实线外框" : "一次性任务 · 虚线外框"}</dd></div><div><dt>工作目录</dt><dd>{selected.cwd}</dd></div></dl><h4>委派内容</h4><Markdown text={selected.promptPreview} />{selected.result && <><h4>最终结果</h4><Markdown text={selected.result.text} /></>}{onOpen && <button className="relations-open" onClick={() => onOpen(selected.id)}>打开完整结果与轨迹 ↗</button>}</aside>}
    </div>
  </section>;
}

export const demoRelationWorkers: RelationWorker[] = [
  ["pi", "running", "persistent", "实现服务端接口", "为项目补充分页接口，保持现有鉴权与响应格式。"],
  ["qoder", "running", "oneshot", "构建前端交互", "完成列表筛选与详情交互，并检查窄屏布局。"],
  ["mcode", "awaiting_input", "persistent", "验证集成流程", "运行集成测试；当前等待确认测试环境的访问权限。"],
  ["qoder", "completed", "persistent", "审查边界条件", "检查并发、取消与恢复路径，给出可复核的审查结论。"],
  ["pi", "cancelled", "oneshot", "探索替代方案", "比较两种缓存方案；方向调整后已取消本轮任务。"],
  ["dsh", "crashed", "oneshot", "检查运行环境", "核对依赖与运行环境；原生进程异常退出，保留执行记录。"],
].map(([runtime, status, persistence, name, promptPreview], index) => ({ id: `demo-${index}`, model: ({ pi: "Claude Sonnet 4.5", qoder: "Qwen3-Coder", mcode: "MiniMax-M3.1", dsh: "DeepSeek-V4" } as Record<string, string>)[runtime!] + "（演示）", runtime: runtime!, status: status!, persistence: persistence!, name, promptPreview: promptPreview!, ownerRef: "demo:project-workspace", lifecycle: status === "completed" ? "idle" : status === "running" ? "busy" : "stopped", cwd: "D:/workspace/project", ...(status === "completed" ? { result: { text: "### 审查完成\n\n- 检查了取消与恢复路径。\n- 未发现阻断性问题。\n\n可继续安排验证任务。", truncated: false } } : {}) }));

// Synthetic projects are only used by the development preview entry.
for (const [projectName, names, ownerRef] of [
  ["docs-site", ["整理安装指南", "检查文档链接", "更新导航结构"], "demo:docs-session"],
  ["data-pipeline", ["验证数据读取", "运行聚合检查", "审查导出格式", "检查失败恢复"], "demo:data-session"],
] as const) {
  names.forEach((name, index) => demoRelationWorkers.push({
    ...demoRelationWorkers[index % demoRelationWorkers.length]!, id: projectName + "-" + index,
    name, ownerRef, cwd: "D:/workspace/" + projectName,
    promptPreview: "在 " + projectName + " 项目中完成：" + name + "。本条为界面演示任务。",
  }));
}

for (const cwd of [...new Set(demoRelationWorkers.map(worker => worker.cwd))]) {
  const originals = demoRelationWorkers.filter(worker => worker.cwd === cwd);
  originals.forEach(worker => { worker.sessionTitle = "功能实现与验证"; });
  originals.slice(0, 2).forEach((worker, index) => demoRelationWorkers.push({
    ...worker, id: worker.id + "-review", ownerRef: worker.ownerRef + ":review", sessionTitle: "质量审查与验收",
    name: index === 0 ? "独立代码审查" : "回归验证", status: index === 0 ? "completed" : "running",
    promptPreview: "对当前项目进行独立审查与验证。本条为第二个会话的演示任务。",
  }));
}
