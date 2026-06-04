/**
 * Codex adapter tests — v2 SDK integration.
 *
 * We mock @openai/codex-sdk so tests run without a real API key.
 */
import { mock, test, expect, describe, beforeAll, afterAll } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";

/* -------------------------------------------------------------------------- */
/*  Mock Codex SDK                                                            */
/* -------------------------------------------------------------------------- */

interface MockThread {
  id: string | null;
  runStreamed(input: string): Promise<{ events: AsyncGenerator<any> }>;
}

function createMockEvents(scenario: string): AsyncGenerator<any> {
  return (async function* () {
    yield { type: "thread.started", thread_id: "t-123" };
    yield { type: "turn.started" };

    if (scenario === "success") {
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "All good." },
      };
      yield { type: "turn.completed", usage: { prompt_tokens: 10, completion_tokens: 5 } };
    } else if (scenario === "outcome") {
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "Done.\n\nOUTCOME: clean" },
      };
      yield { type: "turn.completed", usage: {} };
    } else if (scenario === "failure") {
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "Something went wrong." },
      };
      yield { type: "turn.completed", usage: {} };
    } else if (scenario === "command") {
      yield {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "echo hello",
          aggregated_output: "hello",
          exit_code: 0,
        },
      };
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "Finished." },
      };
      yield { type: "turn.completed", usage: {} };
    } else if (scenario === "error") {
      yield {
        type: "item.completed",
        item: { type: "error", message: "boom" },
      };
      yield { type: "turn.failed", error: { message: "Turn failed" } };
    } else if (scenario === "many_small") {
      for (let i = 0; i < 50; i++) {
        yield {
          type: "item.updated",
          item: { type: "agent_message", text: `chunk-${i}` },
        };
      }
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "All chunks done." },
      };
      yield { type: "turn.completed", usage: {} };
    } else if (scenario === "large_message") {
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "x".repeat(10_000) },
      };
      yield { type: "turn.completed", usage: {} };
    }
  })();
}

mock.module("@openai/codex-sdk", () => {
  const threads = new Map<string, MockThread>();
  let threadCounter = 0;

  class MockCodex {
    constructor(_opts?: any) {}

    startThread(_opts?: any): MockThread {
      const id = `thread-${++threadCounter}`;
      const thread: MockThread = {
        id,
        async runStreamed(input: string) {
          const userPrompt = input.split("\n\n[WORKFLOW INSTRUCTION]")[0];
          const scenario =
            userPrompt.includes("failure")
              ? "failure"
              : userPrompt.includes("outcome")
                ? "outcome"
                : userPrompt.includes("many small")
                  ? "many_small"
                  : userPrompt.includes("large message")
                    ? "large_message"
                    : userPrompt.includes("error")
                      ? "error"
                      : userPrompt.includes("command")
                        ? "command"
                        : "success";
          return { events: createMockEvents(scenario) };
        },
      };
      threads.set(id, thread);
      return thread;
    }

    resumeThread(id: string, _opts?: any): MockThread {
      const existing = threads.get(id);
      if (existing) return existing;
      const thread: MockThread = {
        id,
        async runStreamed(_input: string) {
          return { events: createMockEvents("success") };
        },
      };
      threads.set(id, thread);
      return thread;
    }
  }

  return { Codex: MockCodex };
});

/* -------------------------------------------------------------------------- */
/*  Adapter import (after mock is registered)                                 */
/* -------------------------------------------------------------------------- */

const { adapterConfig } = await import("../index.ts");

/* -------------------------------------------------------------------------- */
/*  Tests                                                                     */
/* -------------------------------------------------------------------------- */

describe("codex adapter v2", () => {
  let host: TestHost;

  beforeAll(async () => {
    host = new TestHost({ config: adapterConfig });
    await host.start();
  });

  afterAll(async () => {
    await host.stop();
  });

  test("openSession + execute success", async () => {
    await host.openSession({
      config: {},
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s1",
      input: { prompt: "Say hello" },
    });

    expect(result.outcome).toBe("success");
    await host.closeSession();
  });

  test("execute with allowed outcomes — valid outcome extracted", async () => {
    await host.openSession({
      config: {},
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s2",
      input: { prompt: "Trigger outcome extraction" },
      allowedOutcomes: ["clean", "failure"],
    });

    expect(result.outcome).toBe("clean");
    await host.closeSession();
  });

  test("execute with allowed outcomes — no valid outcome falls back to failure", async () => {
    await host.openSession({
      config: { model: "o4-mini" },
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s3",
      input: { prompt: "Trigger failure path" },
      allowedOutcomes: ["clean", "failure"],
    });

    expect(result.outcome).toBe("failure");
    await host.closeSession();
  });

  test("streaming many small messages", async () => {
    await host.openSession({
      config: {},
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s4",
      input: { prompt: "many small" },
    });

    expect(result.outcome).toBe("success");
    await host.closeSession();
  });

  test("streaming large message", async () => {
    await host.openSession({
      config: {},
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const result = await host.execute({
      stepName: "s5",
      input: { prompt: "large message" },
    });

    expect(result.outcome).toBe("success");
    await host.closeSession();
  });

  test("snapshot and restore", async () => {
    await host.openSession({
      config: { model: "o4-mini", sandbox_mode: "workspace-write" },
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    const snap = await host.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.state.length).toBeGreaterThan(0);

    await host.restore(snap);

    const result = await host.execute({
      stepName: "s6",
      input: { prompt: "After restore" },
    });

    expect(result.outcome).toBe("success");
    await host.closeSession();
  });

  test("missing prompt throws", async () => {
    await host.openSession({
      config: {},
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    let threw = false;
    try {
      await host.execute({ stepName: "s7", input: {} });
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("input.prompt is required");
    }
    expect(threw).toBe(true);
    await host.closeSession();
  });
});
