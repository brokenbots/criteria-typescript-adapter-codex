/**
 * OpenAI Codex Adapter for Criteria (v2)
 *
 * This adapter uses the official @openai/codex-sdk to run OpenAI Codex
 * as an agentic backend in Criteria workflows.
 *
 * Features:
 * - Agentic coding with the Codex CLI
 * - Multi-turn sessions via Codex threads
 * - Streaming of agent messages, commands, file changes, and reasoning
 * - Outcome extraction from the agent's final response
 * - Snapshot / resume via Codex thread persistence
 *
 * Prerequisites:
 * - The `codex` CLI must be installed (npm i -g @openai/codex)
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "codex"
 *   input {
 *     prompt = "Review this codebase for security issues"
 *   }
 *   outcome "clean" { transition_to = "deploy" }
 *   outcome "issues_found" { transition_to = "review" }
 *   outcome "failure" { transition_to = "failed" }
 * }
 * ```
 */

import type { ServeConfig } from "@criteria/adapter-sdk";
import { serve } from "@criteria/adapter-sdk";
import type { Helpers, ExecuteRequest } from "@criteria/adapter-sdk";
import {
  Codex,
  type Thread,
  type ThreadItem,
  type AgentMessageItem,
  type CommandExecutionItem,
  type FileChangeItem,
  type ReasoningItem,
} from "@openai/codex-sdk";
// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "o4-mini";
const DEFAULT_SANDBOX_MODE = "workspace-write";
const DEFAULT_APPROVAL_POLICY = "on-failure";

const OUTCOME_REGEX = /OUTCOME:\s*(.+?)\s*(?:\n|$)/i;

// ============================================================================
// Schema definitions
// ============================================================================

const ConfigSchema = {
  fields: {
    model: { type: "string", required: false, description: `Model to use (default: ${DEFAULT_MODEL})` },
    sandbox_mode: { type: "string", required: false, description: "Sandbox mode: read-only, workspace-write, danger-full-access (default: workspace-write)" },
    approval_policy: { type: "string", required: false, description: "Approval policy: never, on-request, on-failure, untrusted (default: on-failure)" },
    working_directory: { type: "string", required: false, description: "Working directory for the agent (default: current directory)" },
  },
};

const InputSchema = {
  fields: {
    prompt: { type: "string", required: true, description: "The prompt to send to Codex" },
  },
};

// ============================================================================
// Event Helpers
// ============================================================================

function formatItem(item: ThreadItem): string {
  switch (item.type) {
    case "agent_message":
      return item.text;
    case "reasoning":
      return `[reasoning] ${item.text}`;
    case "command_execution": {
      const cmd = item as CommandExecutionItem;
      let out = `[command] ${cmd.command}`;
      if (cmd.aggregated_output) {
        out += `\n${cmd.aggregated_output}`;
      }
      if (cmd.exit_code !== undefined) {
        out += `\n[exit code: ${cmd.exit_code}]`;
      }
      return out;
    }
    case "file_change": {
      const change = item as FileChangeItem;
      const changes = change.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
      return `[files] ${changes} (${change.status})`;
    }
    case "mcp_tool_call":
      return `[mcp] ${item.tool} on ${item.server}`;
    case "web_search":
      return `[web] ${item.query}`;
    case "todo_list": {
      const todos = item.items.map((t) => `[${t.completed ? "x" : " "}] ${t.text}`).join("\n");
      return `[plan]\n${todos}`;
    }
    case "error":
      return `[error] ${item.message}`;
    default:
      return `[${(item as any).type}]`;
  }
}

// ============================================================================
// Session helpers
// ============================================================================

async function createCodexThread(
  config: Record<string, string>,
  secrets: Record<string, string>
): Promise<{ thread: Thread; model: string; sandboxMode: string; approvalPolicy: string; workingDirectory: string }> {
  const apiKey = secrets["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OpenAI API key is required. Pass it via secrets.OPENAI_API_KEY.");
  }

  const codex = new Codex({
    apiKey,
    baseUrl: secrets["OPENAI_BASE_URL"],
  });

  const model = config["model"] || DEFAULT_MODEL;
  const sandboxMode = config["sandbox_mode"] || DEFAULT_SANDBOX_MODE;
  const approvalPolicy = config["approval_policy"] || DEFAULT_APPROVAL_POLICY;
  const workingDirectory = config["working_directory"] || process.cwd();

  const thread = codex.startThread({
    model,
    sandboxMode: sandboxMode as any,
    approvalPolicy: approvalPolicy as any,
    workingDirectory,
  });

  return { thread, model, sandboxMode, approvalPolicy, workingDirectory };
}

function resumeCodexThread(
  secrets: Record<string, string>,
  threadId: string,
  opts: { model: string; sandboxMode: string; approvalPolicy: string; workingDirectory: string }
): Thread {
  const apiKey = secrets["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OpenAI API key is required. Pass it via secrets.OPENAI_API_KEY.");
  }

  const codex = new Codex({
    apiKey,
    baseUrl: secrets["OPENAI_BASE_URL"],
  });

  return codex.resumeThread(threadId, {
    model: opts.model,
    sandboxMode: opts.sandboxMode as any,
    approvalPolicy: opts.approvalPolicy as any,
    workingDirectory: opts.workingDirectory,
  });
}

// ============================================================================
// Execute Logic
// ============================================================================

async function executeTurn(
  req: ExecuteRequest,
  helpers: Helpers
): Promise<void> {
  const thread = helpers.session.get<Thread>("thread");
  if (!thread) {
    throw new Error("Session not initialized: no thread found");
  }

  const prompt = req.input["prompt"];
  if (!prompt) {
    throw new Error("input.prompt is required");
  }

  const allowedOutcomes = req.allowedOutcomes ?? [];

  let fullPrompt = prompt;
  if (allowedOutcomes.length > 0) {
    fullPrompt +=
      `\n\n[WORKFLOW INSTRUCTION] When you have completed the task, you must end your ` +
      `final message with exactly:\nOUTCOME: <one of: ${allowedOutcomes.join(", ")}>\n` +
      `This is required for the workflow to proceed.`;
  }

  await helpers.log.stdout(`[codex] Starting turn\n`);

  const streamedTurn = await thread.runStreamed(fullPrompt);
  let lastAgentMessage = "";

  for await (const event of streamedTurn.events) {
    switch (event.type) {
      case "thread.started": {
        await helpers.log.adapterEvent("thread.started", { thread_id: event.thread_id });
        break;
      }

      case "turn.started": {
        await helpers.log.adapterEvent("turn.started");
        break;
      }

      case "item.started":
      case "item.updated": {
        const desc = formatItem(event.item);
        await helpers.log.adapterEvent(event.type, {
          itemType: event.item.type,
          description: desc,
        });
        if (event.item.type === "agent_message") {
          lastAgentMessage = (event.item as AgentMessageItem).text;
        }
        break;
      }

      case "item.completed": {
        const desc = formatItem(event.item);
        await helpers.log.adapterEvent("item.completed", {
          itemType: event.item.type,
          description: desc,
        });

        if (event.item.type === "agent_message") {
          const text = (event.item as AgentMessageItem).text;
          lastAgentMessage = text;
          await helpers.log.stdout(text + "\n");
        } else if (event.item.type === "command_execution") {
          await helpers.log.stdout(desc + "\n");
        } else if (event.item.type === "file_change") {
          await helpers.log.stdout(desc + "\n");
        } else if (event.item.type === "error") {
          await helpers.log.stderr(desc + "\n");
        }
        break;
      }

      case "turn.completed": {
        await helpers.log.adapterEvent("turn.completed", {
          usage: event.usage,
        });
        break;
      }

      case "turn.failed": {
        throw new Error(event.error?.message || "Codex turn failed");
      }

      case "error": {
        throw new Error(event.message || "Codex thread error");
      }
    }
  }

  if (allowedOutcomes.length > 0) {
    const match = lastAgentMessage.match(OUTCOME_REGEX);
    if (match) {
      const outcome = match[1].trim();
      const validation = await helpers.outcomes.validate(outcome);
      if (validation.valid) {
        await helpers.outcomes.finalize(outcome, { reason: lastAgentMessage });
        return;
      }
    }
    await helpers.log.adapterEvent("outcome.failure", { reason: "No valid outcome found in agent response" });
    await helpers.outcomes.finalize("failure", { reason: "No valid outcome found in agent response" });
  } else {
    await helpers.outcomes.finalize("success", { reason: lastAgentMessage });
  }
}

// ============================================================================
// Main
// ============================================================================

export const adapterConfig: ServeConfig = {
  name: "codex",
  version: "0.5.0",
  description: "OpenAI Codex adapter for Criteria workflows",
  source_url: "https://github.com/criteria-adapters/codex",
  capabilities: ["multi_turn", "structured_events"],
  platforms: ["linux/amd64", "linux/arm64", "darwin/arm64"],

  config_schema: ConfigSchema,
  input_schema: InputSchema,
  output_schema: undefined,

  secrets: [
    { name: "OPENAI_API_KEY", required: true, description: "OpenAI API key" },
    { name: "OPENAI_BASE_URL", required: false, description: "Override OpenAI API base URL" },
  ],

  permissions: [],

  async openSession(req, helpers) {
    const secrets: Record<string, string> = {};
    const apiKey = await helpers.secrets.get("OPENAI_API_KEY");
    if (apiKey) secrets["OPENAI_API_KEY"] = apiKey;
    const baseUrl = await helpers.secrets.get("OPENAI_BASE_URL");
    if (baseUrl) secrets["OPENAI_BASE_URL"] = baseUrl;

    const { thread, model, sandboxMode, approvalPolicy, workingDirectory } = await createCodexThread(
      req.config,
      secrets
    );

    helpers.session.set("thread", thread);
    helpers.session.set("model", model);
    helpers.session.set("sandbox_mode", sandboxMode);
    helpers.session.set("approval_policy", approvalPolicy);
    helpers.session.set("working_directory", workingDirectory);
    helpers.session.set("secrets", secrets);
  },

  async execute(req, helpers) {
    await executeTurn(req, helpers);
  },

  async snapshot(sessionId, helpers) {
    const thread = helpers.session.get<Thread>("thread");
    const model = helpers.session.get<string>("model") ?? DEFAULT_MODEL;
    const sandboxMode = helpers.session.get<string>("sandbox_mode") ?? DEFAULT_SANDBOX_MODE;
    const approvalPolicy = helpers.session.get<string>("approval_policy") ?? DEFAULT_APPROVAL_POLICY;
    const workingDirectory = helpers.session.get<string>("working_directory") ?? process.cwd();

    const state = {
      threadId: thread?.id ?? null,
      model,
      sandboxMode,
      approvalPolicy,
      workingDirectory,
    };

    const encoder = new TextEncoder();
    return {
      state: encoder.encode(JSON.stringify(state)),
      schemaVersion: 1,
    };
  },

  async restore(sessionId, blob, helpers) {
    const decoder = new TextDecoder();
    const state = JSON.parse(decoder.decode(blob.state));
    const secrets = helpers.session.get<Record<string, string>>("secrets") ?? {};

    let thread: Thread;
    if (state.threadId) {
      thread = resumeCodexThread(secrets, state.threadId, {
        model: state.model,
        sandboxMode: state.sandboxMode,
        approvalPolicy: state.approvalPolicy,
        workingDirectory: state.workingDirectory,
      });
    } else {
      const result = await createCodexThread(
        {
          model: state.model,
          sandbox_mode: state.sandboxMode,
          approval_policy: state.approvalPolicy,
          working_directory: state.workingDirectory,
        },
        secrets
      );
      thread = result.thread;
    }

    helpers.session.set("thread", thread);
    helpers.session.set("model", state.model);
    helpers.session.set("sandbox_mode", state.sandboxMode);
    helpers.session.set("approval_policy", state.approvalPolicy);
    helpers.session.set("working_directory", state.workingDirectory);
  },

  async closeSession(req, helpers) {
    helpers.session.set("thread", undefined);
  },
};

if (import.meta.main) {
  serve(adapterConfig);
}
