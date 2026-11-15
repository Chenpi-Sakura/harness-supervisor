import { randomUUID } from "node:crypto";
import { ownerRefFor } from "./bridge.js";

const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
export const sessionCwd = session => text(session?.header?.cwd, 4096) ?? text(session?.meta?.cwd, 4096);
const modelInfo = value => text(value?.model, 200) ? {
  model: value.model,
  ...(text(value.provider, 200) ? { provider: value.provider } : {}),
  ...(text(value.reasoningEffort, 100) ? { reasoningEffort: value.reasoningEffort } : {}),
} : undefined;

/** DSH rc.3 public getters only: no transcript/config objects or credentials leave the host. */
export function masterSnapshot(agent, namespace, titles) {
  const selection = modelInfo(agent.model?.current?.());
  const lastRequest = modelInfo(agent.session.requestHeader?.()?.config);
  const cwd = sessionCwd(agent.session), title = text(titles?.get(agent.session)?.title, 500);
  return {
    ownerRef: ownerRefFor(namespace, agent.id), harness: "dsh",
    ...(cwd ? { cwd } : {}), ...(title ? { title } : {}),
    ...(selection ? { selection } : {}), ...(lastRequest ? { lastRequest } : {}),
    ...(["idle", "running"].includes(agent.status) ? { status: agent.status } : {}),
  };
}

/** Exact live Agent ownership; a disposed/replaced plugin cannot erase its successor's reports. */
export function createMasterPublisher({ agents, namespace, titles, request, report = () => {} }) {
  const sourceId = randomUUID(), active = new Map();
  let closed = false;
  let pending = Promise.resolve();
  const send = payload => {
    // This client has one transport: serialize initial connects, updates and teardown.
    pending = pending.then(() => request("ui_context", { sourceId, ...payload })).catch(error => {
      // An external older HS may lack this optional presentation capability.
      if (!["BAD_REQUEST", "UNSUPPORTED"].includes(error?.code)) report(error.message);
    });
    return pending;
  };
  const update = async agent => {
    if (closed || agents.get(agent.id) !== agent || agent.session?.id !== agent.id) return;
    try {
      const context = masterSnapshot(agent, namespace, titles);
      active.set(agent.id, agent);
      await send({ context });
    } catch (error) { report(error.message); }
  };
  return {
    update,
    sessionEvent(session, event) {
      const agent = agents.get(session.id);
      if (agent?.session === session && ["session/title", "model/selection", "request/header"].includes(event.type)) void update(agent);
    },
    async remove(agent) {
      if (active.get(agent.id) !== agent) return;
      active.delete(agent.id);
      await send({ ownerRef: ownerRefFor(namespace, agent.id), remove: true });
    },
    async dispose() {
      closed = true;
      const owners = [...active.keys()]; active.clear();
      await Promise.all(owners.map(id => send({ ownerRef: ownerRefFor(namespace, id), remove: true })));
      await pending;
    },
  };
}
