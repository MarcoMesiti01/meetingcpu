import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("skips default Python setup when restricted-machine skip flag is enabled", () => {
  const result = spawnSync(process.execPath, ["scripts/setup-python.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MEETINGCPU_SKIP_PYTHON_SETUP: "true"
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /MEETINGCPU_SKIP_PYTHON_SETUP=true/);
  assert.equal(result.stderr, "");
});
