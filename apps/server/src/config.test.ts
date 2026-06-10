import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server config", () => {
  it("binds the API to loopback by default", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });

  it("prefers the dedicated server port over PORT", () => {
    expect(loadConfig({ PORT: "7000" }).port).toBe(7000);
    expect(loadConfig({ PORT: "7000", MEETINGCPU_SERVER_PORT: "6001" }).port).toBe(6001);
  });

  it("uses a Windows app data directory when available", () => {
    expect(loadConfig({ LOCALAPPDATA: "C:\\Users\\Utente\\AppData\\Local" }, "win32").dataRoot).toBe(
      join("C:\\Users\\Utente\\AppData\\Local", "meetingcpu", "data")
    );
  });

  it("keeps the repo-local data directory when no override is set", () => {
    expect(loadConfig({}, "linux").dataRoot).toBe(resolve("data"));
  });

  it("honors the explicit data directory override", () => {
    expect(loadConfig({ MEETINGCPU_DATA_DIR: "C:\\custom\\meetingcpu" }, "win32").dataRoot).toBe(
      resolve("C:\\custom\\meetingcpu")
    );
  });

  it("parses extra allowed origins from the environment", () => {
    expect(
      loadConfig(
        { MEETINGCPU_ALLOWED_ORIGINS: " http://192.168.1.50:5173, https://devbox.local:4173 , " },
        "win32"
      ).allowedOrigins
    ).toEqual(["http://192.168.1.50:5173", "https://devbox.local:4173"]);
  });

  it("keeps server-side ffmpeg upload fallback disabled unless explicitly enabled", () => {
    expect(loadConfig({}).enableFfmpegUploadFallback).toBe(false);
    expect(loadConfig({ MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK: "true" }).enableFfmpegUploadFallback).toBe(true);
  });
});
