import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
 * - `SDKMessage` itself is a large discriminated union (`'system' |
 *   'assistant' | 'result' | 'stream_event' | 'user' | ...`) whose `type`
 *   values do NOT match our port's `AgentMessage` type strings
 *   (`'assistant_text' | 'tool_use' | 'tool_result' | 'turn_complete'`).
 *   `session-runner.ts`'s `handleMessage` switches on the port's own type
 *   strings with a silent `default: break`, so real SDK messages must be
 *   translated here — passing them through untranslated means every real
 *   message is silently dropped. See `translateSdkMessage` below.
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
      for (const translated of translateSdkMessage(message)) {
        yield translated;
      }
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

/**
 * Translates one real SDK message into zero or more port-shaped
 * `AgentMessage`s. Content-block level detail (text / tool_use / tool_result
 * blocks inside an assistant or user message) can each produce their own
 * event, so this yields an array rather than a single message.
 *
 * Unrecognized message types (`'system'`, `'stream_event'`,
 * `SDKUserMessageReplay`, and the many other control/notification message
 * types the SDK defines) are intentionally ignored — they don't correspond
 * to one of our four port event types.
 */
export function translateSdkMessage(message: SDKMessage): AgentMessage[] {
  switch (message.type) {
    case 'assistant': {
      const content = message.message?.content ?? [];
      const events: AgentMessage[] = [];
      for (const block of content) {
        if (block.type === 'text') {
          events.push({ type: 'assistant_text', text: block.text });
        } else if (block.type === 'tool_use') {
          events.push({ type: 'tool_use', toolName: block.name, input: block.input });
        }
      }
      return events;
    }
    case 'user': {
      // Tool results are delivered back to the model as user-turn
      // `tool_result` content blocks. The block itself only carries
      // `tool_use_id`, not the originating tool's name, so `toolName` is
      // best-effort (empty string) here.
      const content = message.message?.content;
      if (!Array.isArray(content)) return [];
      const events: AgentMessage[] = [];
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'tool_result'
        ) {
          const toolResult = block as { is_error?: boolean };
          events.push({ type: 'tool_result', toolName: '', isError: Boolean(toolResult.is_error) });
        }
      }
      return events;
    }
    case 'result':
      return [{ type: 'turn_complete' }];
    default:
      return [];
  }
}
