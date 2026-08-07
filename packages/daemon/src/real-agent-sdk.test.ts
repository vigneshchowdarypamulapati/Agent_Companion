import { describe, it, expect } from 'vitest';
import { translateSdkMessage } from './real-agent-sdk.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// These fixtures intentionally include only the fields translateSdkMessage
// reads. Real SDKMessage objects carry many more required fields (uuid,
// session_id, etc.) that are irrelevant to the translation logic under test.

describe('translateSdkMessage', () => {
  it('translates an assistant text block to assistant_text', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello there' }],
      },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([
      { type: 'assistant_text', text: 'Hello there' },
    ]);
  });

  it('translates an assistant tool_use block to tool_use', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([
      { type: 'tool_use', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('translates multiple content blocks in one assistant message', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running a command' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([
      { type: 'assistant_text', text: 'Running a command' },
      { type: 'tool_use', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('translates a user tool_result block to tool_result', () => {
    const message = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false }],
      },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([
      { type: 'tool_result', toolName: '', isError: false },
    ]);
  });

  it('marks a failed tool_result as isError: true', () => {
    const message = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }],
      },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([
      { type: 'tool_result', toolName: '', isError: true },
    ]);
  });

  it('ignores a plain user message with string content (no tool_result block)', () => {
    const message = {
      type: 'user',
      message: { content: 'just a synthetic echo' },
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([]);
  });

  it('translates a result message to turn_complete', () => {
    const message = {
      type: 'result',
      subtype: 'success',
    } as unknown as SDKMessage;

    expect(translateSdkMessage(message)).toEqual([{ type: 'turn_complete' }]);
  });

  it('ignores system messages', () => {
    const message = { type: 'system' } as unknown as SDKMessage;
    expect(translateSdkMessage(message)).toEqual([]);
  });

  it('ignores stream_event messages', () => {
    const message = { type: 'stream_event' } as unknown as SDKMessage;
    expect(translateSdkMessage(message)).toEqual([]);
  });
});
