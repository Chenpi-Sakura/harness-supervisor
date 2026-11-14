import { VERSION } from "../../src/version";
import React from "react";

/** The UI version is compiled into the assets, never borrowed from the daemon. */
export function BuildVersions({ coreVersion }: { coreVersion?: string }) {
  return <small className="build-versions"><span>WebUI v{VERSION}</span><span>HS {coreVersion ? `v${coreVersion}` : "未连接"}</span></small>;
}
