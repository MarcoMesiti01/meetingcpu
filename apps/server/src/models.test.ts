import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, getModelOption, listModelOptions, parseModelId } from "./models.js";

describe("model catalog", () => {
  it("uses small as the default CPU-friendly model", () => {
    expect(DEFAULT_MODEL_ID).toBe("small");
    expect(getModelOption(DEFAULT_MODEL_ID)).toMatchObject({
      id: "small",
      recommended: true,
      computeType: "int8"
    });
  });

  it("exposes lightweight and heavier CPU options with warnings", () => {
    const ids = listModelOptions().map((model) => model.id);
    expect(ids).toEqual(["tiny", "base", "small", "medium", "large-v3-turbo", "distil-large-v3"]);
    expect(getModelOption("medium")?.warning).toContain("slow");
    expect(getModelOption("large-v3-turbo")?.warning).toContain("experimental");
  });

  it("rejects unknown model ids with fallback suggestions", () => {
    const result = parseModelId("not-a-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_MODEL");
      expect(result.error.suggestedModelIds).toEqual(["small", "base", "tiny"]);
    }
  });
});
