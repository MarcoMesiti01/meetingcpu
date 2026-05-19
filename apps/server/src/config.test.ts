import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server config", () => {
  it("binds the API to loopback by default", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });
});
