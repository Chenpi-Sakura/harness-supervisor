import React, { useRef } from "react";

export function ResizeHandle({ label, width, onWidth, direction = 1, min = 200, max = 720 }: {
  label: string; width: number; onWidth: (width: number) => void; direction?: number; min?: number; max?: number;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onWidth(Math.min(max, Math.max(min, value)));
  return <div className="pane-resize" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); start.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (start.current) resize(start.current.width + (event.clientX - start.current.x) * direction); }}
    onPointerUp={event => { start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { start.current = null; }} onLostPointerCapture={() => { start.current = null; }}
    onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); resize(width + (event.key === "ArrowRight" ? 16 : -16) * direction); }} />;
}
