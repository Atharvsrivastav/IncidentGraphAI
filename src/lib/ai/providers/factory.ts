import { AIProvider } from "./types";
import { OpenAIProvider } from "./openai";
import { MockAIProvider } from "./mock";
import { AIProviderStatus } from "../types";

let customProvider: AIProvider | null = null;

export function setCustomAIProvider(provider: AIProvider | null): void {
  customProvider = provider;
}

export function getAIProvider(override?: AIProvider): AIProvider {
  if (override) {
    return override;
  }
  if (customProvider) {
    return customProvider;
  }

  const configuredProvider = (process.env.AI_PROVIDER || "").toLowerCase().trim();

  if (configuredProvider === "mock") {
    return new MockAIProvider();
  }

  // Default to OpenAI provider
  return new OpenAIProvider();
}

export function getAIProviderStatus(provider?: AIProvider): AIProviderStatus {
  const activeProvider = provider ?? getAIProvider();
  const isConfigured = activeProvider.isConfigured();

  let details = "";
  if (activeProvider.providerName === "mock") {
    details = "Running with deterministic Mock AI Provider (ideal for tests and local dry-runs).";
  } else if (isConfigured) {
    details = `Connected to hosted ${activeProvider.providerName.toUpperCase()} model (${activeProvider.modelName}).`;
  } else {
    details = "AI provider not configured. Add OPENAI_API_KEY in .env to enable live synthesis. Deterministic DSA engine remains active.";
  }

  return {
    isConfigured,
    providerName: activeProvider.providerName,
    modelName: activeProvider.modelName,
    details,
  };
}
