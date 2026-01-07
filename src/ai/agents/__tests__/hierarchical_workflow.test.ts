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

    (ai.streamText as any).mockResolvedValue({
      fullStream: (async function* () {})(),
    });
  });

  it("should run all four phases (plan, enhance, backend, frontend)", async () => {
    const mockProcessStreamChunks = createMockStreamChunks([
        "## Plan: 1. Do it",
        "## Enhancements: Looks good",
        "<dyad-write path='server.ts'>...",
        "<dyad-write path='client.tsx'>..."
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

    // Plan -> Enhance -> Backend -> Frontend
    expect(ai.streamText).toHaveBeenCalledTimes(4);

    const calls = mockProcessResponseChunkUpdate.mock.calls;
    const lastCall = calls[calls.length - 1][0].fullResponse;
    expect(lastCall).toContain('agent="Planning Agent"');
    expect(lastCall).toContain('agent="Enhance Agent"');
    expect(lastCall).toContain('agent="Backend Builder"');
    expect(lastCall).toContain('agent="Frontend Builder"');
  });

  it("should trigger self-correction loop when critical issues found", async () => {
    const mockProcessStreamChunks = createMockStreamChunks([
        "## Plan: 1. Do it",              // 1. Initial Plan
        "## CRITICAL ISSUES: Missing X",  // 2. Enhance (Validation Failed)
        "## Plan: 1. Do it with X",       // 3. Correction Plan
        "## Endorsement: Looks good",     // 4. Enhance (Validation Passed)
        "Backend Code",                   // 5. Backend
        "Frontend Code"                   // 6. Frontend
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

    // 1(Plan) + 1(Fail) + 1(Retry) + 1(Pass) + 1(Backend) + 1(Frontend) = 6
    expect(ai.streamText).toHaveBeenCalledTimes(6);

    const calls = mockProcessResponseChunkUpdate.mock.calls;
    const lastCall = calls[calls.length - 1][0].fullResponse;

    // Check that we see the correction status
    expect(lastCall).toContain('Correcting Plan (Attempt 1)');
  });
});
