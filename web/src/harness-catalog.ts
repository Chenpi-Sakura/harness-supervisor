import { harnessNames } from "../../src/harness-catalog.js";
export { harnessNames };

export function harnessName(runtime: string): string {
  return harnessNames[runtime] ?? runtime;
}

export interface ModelDisplaySource {
  model?: string;
  config?: { model?: string };
  runtimeInfo?: { modelId?: string; modelName?: string; reasoningEffort?: string; adapter?: string };
}

export function modelDisplay(worker: ModelDisplaySource): string {
  const reported = worker.runtimeInfo;
  if (reported?.modelName || reported?.modelId) return reported.modelName || reported.modelId!;
  const requested = worker.model ?? worker.config?.model;
  return requested ? `${requested}（请求）` : "型号未上报";
}
