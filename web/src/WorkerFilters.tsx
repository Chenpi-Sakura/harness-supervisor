import { useEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";

export interface NavigationFilter { status: string; runtime: string; persistence: string }
export const defaultNavigationFilter: NavigationFilter = { status: "all", runtime: "all", persistence: "all" };

export function WorkerFilters({ value, onChange, runtimes }: { value: NavigationFilter; onChange: (filter: NavigationFilter) => void; runtimes: string[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const count = Object.values(value).filter(item => item !== "all").length;
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const choices = (key: keyof NavigationFilter, items: [string, string][]) => <div className="worker-filter-choices">{items.map(([id, label]) => <button key={id} aria-pressed={value[key] === id} onClick={() => onChange({ ...value, [key]: id })}>{label}</button>)}</div>;
  return <div className="worker-filter" ref={root}><button ref={trigger} className={count ? "has-filters" : ""} aria-label="筛选 Worker" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(previous => !previous)}><UiIcon name="filter" size={15} />筛选{count > 0 && <span>{count}</span>}</button>{open && <div className="worker-filter-panel" role="dialog" aria-label="Worker 筛选条件" tabIndex={-1} ref={panel}><header><strong>筛选 Worker</strong><button onClick={() => onChange(defaultNavigationFilter)}>重置</button></header><section><h4>状态</h4>{choices("status", [["all", "全部"], ["active", "进行中"], ["awaiting_input", "等待输入"], ["terminal", "已结束"]])}</section><section><h4>Harness</h4>{choices("runtime", [["all", "全部"], ...runtimes.map(runtime => [runtime, ({ pi: "Pi", qoder: "Qoder", mcode: "MiniMax Code", dsh: "DeepSeek Harness", codex: "Codex", claude: "Claude Code" } as Record<string,string>)[runtime] ?? runtime] as [string,string])])}</section><section><h4>会话类型</h4>{choices("persistence", [["all", "全部"], ["persistent", "持久会话"], ["oneshot", "一次性任务"]])}</section></div>}</div>;
}
