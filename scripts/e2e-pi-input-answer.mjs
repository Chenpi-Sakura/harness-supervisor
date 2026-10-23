// Answer a real Pi dialog through the public MCP worker_answer tool.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const { values } = parseArgs({ options: {
  "state-dir": { type: "string" }, worker: { type: "string" }, "request-id": { type: "string" },
} });
if (!values["state-dir"] || !values.worker || !values["request-id"]) throw new Error("Missing state-dir, worker or request-id");
const client = new Client({ name: "hs-native-input-e2e", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/mcp.js", import.meta.url)), "--state-dir", values["state-dir"]],
  }));
  const result = await client.callTool({ name: "worker_answer", arguments: {
    workerId: values.worker, requestId: values["request-id"], response: { value: "HS_INPUT_OK" },
  } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  console.log(JSON.stringify({ tool: "worker_answer", result }));
} finally { await client.close(); }
