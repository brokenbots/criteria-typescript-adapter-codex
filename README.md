# OpenAI Codex Adapter Example

This example demonstrates using the official `@openai/codex-sdk` to run OpenAI Codex as an agentic backend in Criteria workflows.

## Features

- Agentic coding with the Codex CLI
- Multi-turn sessions via Codex threads
- Streaming of agent messages, commands, file changes, and reasoning
- Outcome extraction from the agent's final response
- Configurable sandbox mode and approval policy

## Prerequisites

1. **Install the Codex CLI:**
   ```bash
   npm install -g @openai/codex
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Build the adapter:**
   ```bash
   bun run build
   ```

4. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp criteria-adapter-codex ~/.criteria/plugins/
   chmod +x ~/.criteria/plugins/criteria-adapter-codex
   ```

## Secrets

The adapter reads the OpenAI API key from the Criteria secret store (not environment variables):

- `OPENAI_API_KEY` — **required**
- `OPENAI_BASE_URL` — optional override for the OpenAI API base URL

Pass secrets when running a workflow via the Criteria CLI or orchestrator.

## Usage

Create a workflow file:

```hcl
step "analyze" {
  adapter = "codex"

  agent {
    config {
      model           = "o4-mini"
      sandbox_mode    = "workspace-write"
      approval_policy = "on-failure"
    }
  }

  input {
    prompt = "Review this code for bugs: $(file src/main.ts)"
  }

  outcome "clean" { transition_to = "deploy" }
  outcome "issues_found" { transition_to = "fix" }
  outcome "failure" { transition_to = "failed" }
}
```

Run the workflow:
```bash
criteria apply workflow.hcl
```

## Configuration

### Agent-level config (set once per session)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model` | string | No | `o4-mini` | Model to use |
| `sandbox_mode` | string | No | `workspace-write` | Sandbox restrictions |
| `approval_policy` | string | No | `on-failure` | When to ask for approval |
| `working_directory` | string | No | current dir | Working directory for the agent |

### Secrets (provided by the Criteria host)

| Name | Required | Description |
|------|----------|-------------|
| `OPENAI_API_KEY` | **Yes** | OpenAI API key |
| `OPENAI_BASE_URL` | No | Custom API base URL |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to Codex |

## How It Works

The adapter interfaces with the Codex CLI via the `@openai/codex-sdk` using the Criteria v2 adapter SDK:

1. **Session Open**: Creates a Codex client and starts a new thread
2. **Execute**: Sends the prompt to the Codex agent
3. **Streaming**: Streams structured events (agent messages, commands, file changes, reasoning) back to Criteria via `helpers.log.adapterEvent(...)`
4. **Outcome Extraction**: The adapter appends instructions to the prompt requesting the agent end its response with `OUTCOME: <outcome_name>`. The adapter parses the final message to determine the workflow outcome.
5. **Snapshot / Restore**: Persists the Codex thread ID and session config so a long-running session can be resumed across process restarts
6. **Result**: Returns the outcome to Criteria for workflow transition

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `bun run build`
3. Run tests: `bun test`
4. Test with `criteria apply`
