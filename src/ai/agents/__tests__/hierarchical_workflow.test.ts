import { describe, it, expect, vi, beforeEach } from "vitest";
import { runHierarchicalWorkflow } from "../hierarchical_workflow";
import * as ai from "ai";
import * as get_model_client from "../../../ipc/utils/get_model_client";
import * as token_utils from "../../../ipc/utils/token_utils";
import * as thinking_utils from "../../../ipc/utils/thinking_utils";

// Mock dependencies
vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("../../../ipc/utils/get_model_client", () => ({
  getModelClient: vi.fn(),
}));

vi.mock("../../../ipc/utils/token_utils", () => ({
  getMaxTokens: vi.fn(),
}));

vi.mock("../../../ipc/utils/thinking_utils", () => ({
  getExtraProviderOptions: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("runHierarchicalWorkflow", () => {
  const mockChatMessages = [
    { role: "user", content: "Build a todo app" },
  ];

  const mockModelClient = {
    model: {},
    builtinProviderId: "openai",
  };

  const mockSettings = {
    selectedModel: "gpt-4",
  };

  const mockAbortController = new AbortController();
  const mockChatId = 123;

  // Mocks for processing functions
  const mockProcessResponseChunkUpdate = vi.fn().mockImplementation(({ fullResponse }) => Promise.resolve(fullResponse));

  // Create a mock implementation that appends content to simulate AI output
  // This is crucial for testing the self-correction loop logic which inspects the output string
  const createMockStreamChunks = (responses: string[]) => {
    let callCount = 0;
    return vi.fn().mockImplementation(async ({ fullResponse }) => {
      // Return specific response based on call count if available, otherwise default
      const chunk = responses[callCount] || " [OK] ";
      callCount++;
      return Promise.resolve({ fullResponse: fullResponse + chunk, incrementalResponse: chunk });
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (token_utils.getMaxTokens as any).mockResolvedValue(1000);
    (thinking_utils.getExtraProviderOptions as any).mockReturnValue({});

    // Mock streamText to return a dummy stream (the text content comes from processStreamChunks mock)
    (ai.streamText as any).mockResolvedValue({
      fullStream: (async function* () {})(),
    });
  });

  it("should run all three phases (plan, enhance, build) when no critical issues", async () => {
    const mockProcessStreamChunks = createMockStreamChunks([
        "## Plan: 1. Do it",
        "## Enhancements: Looks good",
        "## Code: <dyad-write...>"
    ]);

    await runHierarchicalWorkflow({
      chatMessages: mockChatMessages,
      modelClient: mockModelClient,
      systemPrompt: "System Prompt",
      settings: mockSettings,
      abortController: mockAbortController,
      chatId: mockChatId,
      processResponseChunkUpdate: mockProcessResponseChunkUpdate,
      processStreamChunks: mockProcessStreamChunks,
    });

    // Plan -> Enhance -> Build
    expect(ai.streamText).toHaveBeenCalledTimes(3);

    const calls = mockProcessResponseChunkUpdate.mock.calls;
    const lastCall = calls[calls.length - 1][0].fullResponse;
    expect(lastCall).toContain('agent="Planning Agent"');
    expect(lastCall).toContain('agent="Enhance Agent"');
    expect(lastCall).toContain('agent="Building Agent"');
  });

  it("should trigger self-correction loop when critical issues found", async () => {
    const mockProcessStreamChunks = createMockStreamChunks([
        "## Plan: 1. Do it",              // 1. Initial Plan
        "## CRITICAL ISSUES: Missing X",  // 2. Enhance (Validation Failed)
        "## Plan: 1. Do it with X",       // 3. Correction Plan
        "## Endorsement: Looks good",     // 4. Enhance (Validation Passed)
        "## Code: <dyad-write...>"        // 5. Build
    ]);

    await runHierarchicalWorkflow({
      chatMessages: mockChatMessages,
      modelClient: mockModelClient,
      systemPrompt: "System Prompt",
      settings: mockSettings,
      abortController: mockAbortController,
      chatId: mockChatId,
      processResponseChunkUpdate: mockProcessResponseChunkUpdate,
      processStreamChunks: mockProcessStreamChunks,
    });

    // 1 (Plan) + 1 (Enhance Fail) + 1 (Plan Retry) + 1 (Enhance Pass) + 1 (Build) = 5
    expect(ai.streamText).toHaveBeenCalledTimes(5);

    const calls = mockProcessResponseChunkUpdate.mock.calls;
    const lastCall = calls[calls.length - 1][0].fullResponse;

    // Check that we see the correction status
    expect(lastCall).toContain('Correcting Plan (Attempt 1)');
  });

  it("should abort early if abortController is triggered", async () => {
    const mockProcessStreamChunks = createMockStreamChunks(["..."]);

    // Mock streamText to trigger abort
    (ai.streamText as any).mockImplementation(async () => {
        mockAbortController.abort();
        return { fullStream: (async function* () {})() };
    });

    await runHierarchicalWorkflow({
      chatMessages: mockChatMessages,
      modelClient: mockModelClient,
      systemPrompt: "System Prompt",
      settings: mockSettings,
      abortController: mockAbortController,
      chatId: mockChatId,
      processResponseChunkUpdate: mockProcessResponseChunkUpdate,
      processStreamChunks: mockProcessStreamChunks,
    });

    // Should stop after the first call because we aborted
    expect(ai.streamText).toHaveBeenCalledTimes(1);
  });
});
