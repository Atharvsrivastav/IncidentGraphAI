import { AIProvider, AIInvestigationContext, AIProviderResult, AIProviderError } from "./types";
import { buildInvestigationSystemPrompt, buildInvestigationUserPrompt } from "../promptBuilder";

export class OpenAIProvider implements AIProvider {
  public readonly providerName = "openai";
  public readonly modelName: string;

  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(options?: { apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.modelName = options?.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.baseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.timeoutMs = options?.timeoutMs ?? (Number(process.env.AI_REQUEST_TIMEOUT_MS) || 20000);
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0 && !this.apiKey.startsWith("sk-placeholder"));
  }

  public async generateInvestigation(context: AIInvestigationContext): Promise<AIProviderResult> {
    if (!this.isConfigured()) {
      throw new AIProviderError(
        "OpenAI provider is not configured. Set OPENAI_API_KEY in .env to enable live AI synthesis.",
        "UNCONFIGURED",
        503
      );
    }

    const systemPrompt = buildInvestigationSystemPrompt();
    const userPrompt = buildInvestigationUserPrompt(context);

    const payload = {
      model: this.modelName,
      temperature: 0.1, // low temperature for deterministic, calibrated outputs
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    const startTime = Date.now();
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError" || errorMsg.includes("timeout"))) {
        throw new AIProviderError(
          `OpenAI request timed out after ${this.timeoutMs}ms. Investigation synthesis aborted.`,
          "TIMEOUT",
          504
        );
      }
      throw new AIProviderError(
        `Failed to connect to OpenAI provider: ${errorMsg}`,
        "NETWORK_ERROR",
        502
      );
    }

    const executionTimeMs = Date.now() - startTime;

    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        // Ignored
      }

      if (response.status === 401 || response.status === 403) {
        throw new AIProviderError(
          "OpenAI authentication failed. Please verify your OPENAI_API_KEY in .env.",
          "AUTHENTICATION_FAILED",
          401
        );
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || 30;
        throw new AIProviderError(
          `OpenAI rate limit exceeded (HTTP 429). Please retry after ${retryAfter}s.`,
          "RATE_LIMITED",
          429,
          retryAfter
        );
      }

      throw new AIProviderError(
        `OpenAI API returned error HTTP ${response.status}: ${errorBody.slice(0, 300)}`,
        "PROVIDER_UNAVAILABLE",
        response.status
      );
    }

    let responseData: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    try {
      responseData = await response.json();
    } catch {
      throw new AIProviderError(
        "OpenAI returned non-JSON response body.",
        "MALFORMED_OUTPUT",
        502
      );
    }

    const content = responseData.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new AIProviderError(
        "OpenAI response contained empty completion content.",
        "MALFORMED_OUTPUT",
        502
      );
    }

    // Clean any accidental markdown fence wrap
    let cleanJson = content.trim();
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    return {
      rawJson: cleanJson,
      promptTokens: responseData.usage?.prompt_tokens,
      completionTokens: responseData.usage?.completion_tokens,
      totalTokens: responseData.usage?.total_tokens,
      executionTimeMs,
    };
  }
}
