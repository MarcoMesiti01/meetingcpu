export function reportProcessFailure(failures, writeError = console.error) {
  const failureList = Array.isArray(failures) ? failures : [];
  const failure = failureList.find((item) => !item.killed) ?? failureList[0];
  const name = failure?.command?.name ?? "development service";
  const exitCode = failure?.exitCode ?? "unknown";

  writeError(`[dev] ${name} exited with code ${exitCode}. See the service output above for the underlying error.`);
}
