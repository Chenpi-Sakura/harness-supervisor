import React, { useEffect, useId, useRef, useState } from "react";
import { Markdown } from "./Markdown";

export interface PromptDetail { text: string; available: boolean }

export function TaskPrompt({ preview, load }: { preview: string; load: (signal: AbortSignal) => Promise<PromptDetail> }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<PromptDetail | null>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    setContent(null);
    setError("");
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) setContent(value);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败");
    });
    return () => {
      controller.abort();
      dialog.current?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open, load]);

  return <>
    <button type="button" className="task-description" aria-label="查看完整任务说明" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <span>{preview.replace(/\.*\s*\[truncated \d+ chars\]$/, "...")}</span>
    </button>
    {open && <dialog className="prompt-dialog" ref={dialog} aria-labelledby={title} onClose={() => setOpen(false)} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) setOpen(false);
    }}>
      <div className="prompt-dialog-header"><h3 id={title}>任务说明</h3><button autoFocus type="button" aria-label="关闭任务说明" onClick={() => setOpen(false)}>×</button></div>
      <div className="prompt-dialog-body" tabIndex={0}>
        {!content && !error && <p className="muted" role="status">正在读取任务说明…</p>}
        {error && <p role="alert">{error}</p>}
        {content && <><Markdown text={content.text} />{!content.available && <p className="muted prompt-history-note">此记录仅保存了任务摘要，截断部分无法恢复。</p>}</>}
      </div>
    </dialog>}
  </>;
}
