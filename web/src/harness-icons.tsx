import { UiIcon } from "./UiIcon";
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
    {!known && <UiIcon name="terminal" size={size} />}
  </span>;
}
