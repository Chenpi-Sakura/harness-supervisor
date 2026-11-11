import "./harness-icons.css";

const labels: Record<string, string> = {
  pi: "Pi",
  qoder: "Qoder",
  mcode: "MiniMax Code",
  dsh: "DeepSeek Harness",
};

/** Local, decorative brand mark; callers retain the visible Harness label. */
export function HarnessIcon({ runtime, size = 18 }: { runtime: string; size?: 16 | 18 | 20 | 24 }) {
  const known = Object.hasOwn(labels, runtime);
  return <span className={`harness-icon harness-icon--${known ? runtime : "generic"} harness-icon--${size}`} aria-hidden="true" title={known ? labels[runtime] : runtime}>
    {!known && <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m7 10 3 2-3 2m6 0h4" /></svg>}
  </span>;
}
