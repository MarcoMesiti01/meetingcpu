export type ModelId = "tiny" | "base" | "small" | "medium" | "large-v3-turbo" | "distil-large-v3";

export interface ModelOption {
  id: ModelId;
  label: string;
  quality: "low" | "balanced" | "high" | "experimental";
  speed: "fastest" | "fast" | "moderate" | "slow" | "very-slow";
  recommended: boolean;
  computeType: "int8";
  warning?: string;
}

export interface ModelParseError {
  code: "UNKNOWN_MODEL";
  message: string;
  suggestedModelIds: ModelId[];
}

export type ModelParseResult = { ok: true; value: ModelId } | { ok: false; error: ModelParseError };

export const DEFAULT_MODEL_ID: ModelId = "small";

const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "tiny",
    label: "Tiny",
    quality: "low",
    speed: "fastest",
    recommended: false,
    computeType: "int8"
  },
  {
    id: "base",
    label: "Base",
    quality: "balanced",
    speed: "fast",
    recommended: false,
    computeType: "int8"
  },
  {
    id: "small",
    label: "Small",
    quality: "balanced",
    speed: "moderate",
    recommended: true,
    computeType: "int8"
  },
  {
    id: "medium",
    label: "Medium",
    quality: "high",
    speed: "slow",
    recommended: false,
    computeType: "int8",
    warning: "May be slow on CPU-centered laptops."
  },
  {
    id: "large-v3-turbo",
    label: "Large v3 Turbo",
    quality: "experimental",
    speed: "very-slow",
    recommended: false,
    computeType: "int8",
    warning: "Experimental on CPU. May be very slow or fail on memory-limited machines."
  },
  {
    id: "distil-large-v3",
    label: "Distil Large v3",
    quality: "experimental",
    speed: "very-slow",
    recommended: false,
    computeType: "int8",
    warning: "Experimental on CPU. May be very slow or fail on memory-limited machines."
  }
];

export function listModelOptions(): ModelOption[] {
  return MODEL_OPTIONS.map((model) => ({ ...model }));
}

export function getModelOption(modelId: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((model) => model.id === modelId);
}

export function parseModelId(modelId: string | undefined): ModelParseResult {
  if (!modelId) {
    return { ok: true, value: DEFAULT_MODEL_ID };
  }

  const option = getModelOption(modelId);
  if (option) {
    return { ok: true, value: option.id };
  }

  return {
    ok: false,
    error: {
      code: "UNKNOWN_MODEL",
      message: `Unknown model "${modelId}". Choose one of: ${MODEL_OPTIONS.map((model) => model.id).join(", ")}.`,
      suggestedModelIds: ["small", "base", "tiny"]
    }
  };
}
