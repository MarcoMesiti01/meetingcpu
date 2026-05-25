import assert from "node:assert/strict";
import test from "node:test";

import { reportProcessFailure } from "./dev-result.mjs";

test("reports a failed development process without exposing its environment", () => {
  const output = [];
  const failures = [
    {
      command: {
        name: "whisper",
        spawnOpts: {
          env: {
            OPENAI_API_KEY: "secret-value"
          }
        }
      },
      exitCode: 1,
      killed: false
    }
  ];

  reportProcessFailure(failures, (message) => output.push(message));

  assert.deepEqual(output, [
    "[dev] whisper exited with code 1. See the service output above for the underlying error."
  ]);
  assert.doesNotMatch(output.join("\n"), /OPENAI_API_KEY|secret-value/);
});

