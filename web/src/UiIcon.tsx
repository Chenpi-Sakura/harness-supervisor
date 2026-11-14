import { ArrowUpRight, ChevronDown, ChevronRight, Maximize, Minimize, Minus, Moon, PanelLeft, Plus, RotateCcw, Search, SlidersHorizontal, Sun, Terminal, X } from "lucide-react";

const icons = { arrowUpRight: ArrowUpRight, chevronDown: ChevronDown, chevronRight: ChevronRight, maximize: Maximize, minimize: Minimize, minus: Minus, moon: Moon, panelLeft: PanelLeft, plus: Plus, reset: RotateCcw, search: Search, filter: SlidersHorizontal, sun: Sun, terminal: Terminal, close: X };

export function UiIcon({ name, size = 18, className }: { name: keyof typeof icons; size?: number; className?: string }) {
  const Icon = icons[name];
  return <Icon aria-hidden="true" size={size} strokeWidth={1.75} className={className} />;
}
