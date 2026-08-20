import { describe, it, expect, vi } from 'vitest';
import { translateSdkMessage, realQueryFn, realListSessionsFn, realGetSessionMessagesFn } from './real-agent-sdk.js';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
}));

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

describe('realQueryFn — resume and fork options', () => {
  it('passes sessionId, resume, and forkSession through when resumeSessionId is set', () => {
    let capturedOptions: Record<string, unknown> = {};
    vi.mocked(query).mockImplementation((args) => {
      capturedOptions = args.options as Record<string, unknown>;
      return (async function* () {})() as ReturnType<typeof query>;
    });

    realQueryFn({
      prompt: (async function* () {})(),
      options: {
        cwd: '/tmp/project',
        canUseTool: async () => ({ approved: true }),
        sessionId: 'new-session-1',
        resumeSessionId: 'original-session-1',
      },
    });

    expect(capturedOptions.sessionId).toBe('new-session-1');
    expect(capturedOptions.resume).toBe('original-session-1');
    expect(capturedOptions.forkSession).toBe(true);
  });

  it('passes neither sessionId, resume, nor forkSession when resumeSessionId is absent (normal fresh start)', () => {
    let capturedOptions: Record<string, unknown> = {};
    vi.mocked(query).mockImplementation((args) => {
      capturedOptions = args.options as Record<string, unknown>;
      return (async function* () {})() as ReturnType<typeof query>;
    });

    realQueryFn({
      prompt: (async function* () {})(),
      options: {
        cwd: '/tmp/project',
        canUseTool: async () => ({ approved: true }),
      },
    });

    expect(capturedOptions.sessionId).toBeUndefined();
    expect(capturedOptions.resume).toBeUndefined();
    expect(capturedOptions.forkSession).toBeUndefined();
  });
});

describe('realListSessionsFn', () => {
  it('maps SDK SDKSessionInfo entries into DiscoveredSession, passing includeProgrammatic: false', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'abc-123',
        summary: 'Fix the auth bug',
        lastModified: 1700000000000,
        firstPrompt: 'fix the bug in auth.ts',
      },
    ] as Awaited<ReturnType<typeof listSessions>>);

    const result = await realListSessionsFn({ dir: '/tmp/project' });

    expect(listSessions).toHaveBeenCalledWith({ dir: '/tmp/project', includeProgrammatic: false });
    expect(result).toEqual([
      {
        sessionId: 'abc-123',
        summary: 'Fix the auth bug',
        firstPrompt: 'fix the bug in auth.ts',
        lastModified: 1700000000000,
      },
    ]);
  });

  it('maps a missing firstPrompt to undefined, not a crash', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { sessionId: 'abc-123', summary: 'Untitled', lastModified: 1700000000000 },
    ] as Awaited<ReturnType<typeof listSessions>>);

    const result = await realListSessionsFn({ dir: '/tmp/project' });

    expect(result[0].firstPrompt).toBeUndefined();
  });
});

describe('realGetSessionMessagesFn', () => {
  it('extracts text from assistant and user messages, dropping system messages', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] },
      },
      {
        type: 'system',
        uuid: 'sys1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'system', content: [{ type: 'text', text: 'compact boundary' }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(getSessionMessages).toHaveBeenCalledWith('s1', { dir: '/tmp/project' });
    expect(result).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'Found it.' },
    ]);
  });

  it('joins multiple text blocks within one message', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'First. ' }, { type: 'text', text: 'Second.' }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(result).toEqual([{ role: 'assistant', text: 'First. Second.' }]);
  });

  it('drops a message that yields no text after extraction (e.g. a pure tool-use turn)', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(result).toEqual([]);
  });
});
