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
  const mockProcessStreamChunks = vi.fn().mockImplementation(({ fullResponse }) => {
    return Promise.resolve({ fullResponse: fullResponse + " [CHUNK]", incrementalResponse: " [CHUNK]" });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (token_utils.getMaxTokens as any).mockResolvedValue(1000);
    (thinking_utils.getExtraProviderOptions as any).mockReturnValue({});

    // Mock streamText to return a dummy stream
    (ai.streamText as any).mockResolvedValue({
      fullStream: (async function* () {})(), // Empty async generator
    });
  });

  it("should run all three phases (plan, enhance, build)", async () => {
    // Setup mock outputs for each phase
    // We can't easily mock sequential different return values for streamText without complex setup
    // because streamText returns a stream, not the text directly.
    // The text accumulation happens in processStreamChunks.

    // However, we can verify that streamText is called 3 times.

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

    // Verify streamText was called 3 times (Plan, Enhance, Build)
    expect(ai.streamText).toHaveBeenCalledTimes(3);

    // Verify processResponseChunkUpdate was called to inject status tags
    // 3 times for status tags + 3 times for chunks (from mockProcessStreamChunks)
    // Actually, processResponseChunkUpdate is called inside runStep (once for status) + inside processStreamChunks (for chunks)
    expect(mockProcessResponseChunkUpdate).toHaveBeenCalled();

    // Verify status tags were injected
    const calls = mockProcessResponseChunkUpdate.mock.calls;
    const statusTags = calls.filter(call => call[0].fullResponse.includes("<dyad-status"));
    expect(statusTags.length).toBeGreaterThanOrEqual(3);

    expect(statusTags[0][0].fullResponse).toContain('agent="Planning Agent"');
    // Note: fullResponse accumulates, so the last call should contain all tags
    const lastCall = calls[calls.length - 1][0].fullResponse;
    expect(lastCall).toContain('agent="Planning Agent"');
    expect(lastCall).toContain('agent="Enhance Agent"');
    expect(lastCall).toContain('agent="Building Agent"');
  });

  it("should abort early if abortController is triggered", async () => {
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
