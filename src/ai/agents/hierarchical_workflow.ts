import { streamText, CoreMessage } from "ai";
import { ModelClient } from "../../ipc/utils/get_model_client";
import {
  PLANNING_AGENT_SYSTEM_PROMPT,
  ENHANCE_AGENT_SYSTEM_PROMPT,
} from "./prompts";
import { getMaxTokens } from "../../ipc/utils/token_utils";
import { v4 as uuidv4 } from "uuid";
import { getExtraProviderOptions } from "../../ipc/utils/thinking_utils";
import { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";

type ProcessStreamChunks = (params: {
  fullStream: AsyncIterable<any>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
}) => Promise<{ fullResponse: string; incrementalResponse: string }>;

interface HierarchicalWorkflowParams {
  chatMessages: CoreMessage[];
  modelClient: ModelClient;
  systemPrompt: string;
  settings: any;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
  processStreamChunks: ProcessStreamChunks;
}

export async function runHierarchicalWorkflow({
  chatMessages,
  modelClient,
  systemPrompt, // This is the Builder's system prompt (the main one)
  settings,
  abortController,
  chatId,
  processResponseChunkUpdate,
  processStreamChunks,
}: HierarchicalWorkflowParams) {
  let fullResponse = "";
  const dyadRequestId = uuidv4();
  const providerOptions = {
    "dyad-engine": {
      dyadRequestId,
    },
    "dyad-gateway": getExtraProviderOptions(
      modelClient.builtinProviderId,
      settings,
    ),
    google: {
      thinkingConfig: {
        includeThoughts: true,
      },
    } satisfies GoogleGenerativeAIProviderOptions,
  };

  // Helper to run a step
  const runStep = async (
    agentName: string,
    prompt: string,
    history: CoreMessage[],
  ) => {
    // Inject status tag
    const statusTag = `\n\n<dyad-status agent="${agentName}">Thinking...</dyad-status>\n\n`;
    fullResponse += statusTag;
    await processResponseChunkUpdate({ fullResponse });

    const maxTokens = await getMaxTokens(settings.selectedModel);

    // We only send the last user message + context for the agents to save tokens/confusion,
    // or we can send full history. Let's send full history but with a modified system prompt.
    // Actually, we need to be careful. The agents are "separate entities".
    // Let's treat them as continuation of the conversation for simplicity in context management.

    const messages = [...history];

    const result = await streamText({
      maxTokens,
      temperature: 0,
      maxRetries: 2,
      model: modelClient.model,
      providerOptions,
      system: prompt,
      messages: messages.filter((m) => m.content),
      abortSignal: abortController.signal,
    });

    const { fullStream } = result;
    const chunkResult = await processStreamChunks({
      fullStream,
      fullResponse,
      abortController,
      chatId,
      processResponseChunkUpdate,
    });

    fullResponse = chunkResult.fullResponse;
    return chunkResult.incrementalResponse;
  };

  let retryCount = 0;
  const MAX_RETRIES = 1;

  // --- Phase 1: Planning ---
  let planningOutput = await runStep(
    "Planning Agent",
    PLANNING_AGENT_SYSTEM_PROMPT,
    chatMessages
  );

  if (abortController.signal.aborted) return fullResponse;

  let enhanceOutput = "";
  let needsCorrection = true;

  // --- Phase 2: Enhance & Correction Loop ---
  while (needsCorrection && retryCount <= MAX_RETRIES) {
    if (abortController.signal.aborted) return fullResponse;

    const enhanceInputMessages: CoreMessage[] = [
      ...chatMessages,
      { role: "assistant", content: planningOutput },
      { role: "user", content: "Please review the plan for correctness and suggest enhancements. If there are CRITICAL ISSUES, specifically mention them." }
    ];

    enhanceOutput = await runStep(
      "Enhance Agent",
      ENHANCE_AGENT_SYSTEM_PROMPT,
      enhanceInputMessages
    );

    // Check for critical issues in the Enhancer's output
    if (enhanceOutput.includes("## CRITICAL ISSUES") && retryCount < MAX_RETRIES) {
      retryCount++;
      const statusTag = `\n\n<dyad-status agent="Planning Agent">Correcting Plan (Attempt ${retryCount})...</dyad-status>\n\n`;
      fullResponse += statusTag;
      await processResponseChunkUpdate({ fullResponse });

      // Re-run Planner with feedback
      const correctionMessages: CoreMessage[] = [
        ...chatMessages,
        { role: "assistant", content: planningOutput },
        { role: "user", content: `The Enhance Agent found critical issues:\n${enhanceOutput}\n\nPlease regenerate the plan to address these issues.` }
      ];

      planningOutput = await runStep(
        "Planning Agent",
        PLANNING_AGENT_SYSTEM_PROMPT,
        correctionMessages
      );
    } else {
      needsCorrection = false;
    }
  }

  if (abortController.signal.aborted) return fullResponse;

  // --- Phase 3: Building (The Main Builder) ---
  // The Builder receives the original context + Final Plan + Final Enhancements.

  const builderMessages: CoreMessage[] = [
    ...chatMessages,
    {
      role: "assistant",
      content: `Here is the approved plan:\n${planningOutput}\n\nAnd the validation/enhancements:\n${enhanceOutput}`
    },
    {
      role: "user",
      content: "Great, please proceed with building the app following the plan and validation."
    }
  ];

  // Run the Builder (Standard System Prompt)
  const statusTag = `\n\n<dyad-status agent="Building Agent">Writing code...</dyad-status>\n\n`;
  fullResponse += statusTag;
  await processResponseChunkUpdate({ fullResponse });

  const builderResult = await streamText({
    maxTokens: await getMaxTokens(settings.selectedModel),
    temperature: 0,
    maxRetries: 2,
    model: modelClient.model,
    providerOptions,
    system: systemPrompt,
    messages: builderMessages.filter((m) => m.content),
    abortSignal: abortController.signal,
  });

  const { fullStream } = builderResult;
  const chunkResult = await processStreamChunks({
    fullStream,
    fullResponse,
    abortController,
    chatId,
    processResponseChunkUpdate,
  });

  fullResponse = chunkResult.fullResponse;

  return fullResponse;
}
