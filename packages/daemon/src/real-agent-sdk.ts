import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';

/**
 * Adapts the real `@anthropic-ai/claude-agent-sdk` package to our `QueryFn`
 * port interface (defined in `agent-sdk-port.ts`).
 *
 * The installed SDK's actual shape differs from early documentation-derived
 * assumptions in a few load-bearing ways:
 *
 * - `query()`'s streaming prompt expects full `SDKUserMessage` objects
 *   (`{ type: 'user', message: { role: 'user', content }, parent_tool_use_id
 *   }`), not a bare `{ type: 'user', text }` shape.
 * - `options.canUseTool` is `(toolName, input, { requestId, ... }) =>
 *   Promise<PermissionResult | null>` — three positional arguments, not a
 *   single request object — and the result uses a `behavior: 'allow' |
 *   'deny'` discriminated union (with `message` required on deny), not an
 *   `{ approved }` shape.
 * - The returned `Query` is an `AsyncGenerator<SDKMessage, void>` with
 *   `interrupt()`, `close()`, and other control methods; `interrupt()`
 *   resolves to an optional receipt rather than `void`, which is fine since
 *   our port's `interrupt(): Promise<void>` only needs it to resolve.
 */
export const realQueryFn: QueryFn = ({ prompt, options }) => {
  async function* toSdkPrompt(): AsyncGenerator<SDKUserMessage> {
    for await (const message of prompt) {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: message.text,
        },
        parent_tool_use_id: null,
      };
    }
  }

  const sdkQuery = query({
    prompt: toSdkPrompt(),
    options: {
      cwd: options.cwd,
      canUseTool: async (toolName, input, { requestId }) => {
        const response = await options.canUseTool({
          requestId,
          toolName,
          input,
        });
        return response.approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: response.reason ?? 'Denied' };
      },
    },
  });

  async function* toAgentMessages(): AsyncGenerator<AgentMessage> {
    for await (const message of sdkQuery) {
      yield message as unknown as AgentMessage;
    }
  }

  const agentQuery: AgentQuery = {
    [Symbol.asyncIterator]: () => toAgentMessages(),
    interrupt: async () => {
      await sdkQuery.interrupt();
    },
    close: () => sdkQuery.close(),
  };

  return agentQuery;
};
