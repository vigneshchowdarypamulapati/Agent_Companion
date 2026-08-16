import type { Command } from '@companion/protocol';
import type { SessionManager } from './session-manager.js';

/**
 * Applies a Command to the given SessionManager. Shared by the local HTTP
 * control surface (http-server.ts) and the relay client's incoming-command
 * handler (relay-client.ts via main.ts, through dispatchCommandWithAck below),
 * so the two channels apply commands identically and can never drift.
 *
 * Deliberately has no notion of `commandId` or acking — see dispatchCommandWithAck, which wraps
 * this for the one caller (the relay path) that needs both.
 */
export async function dispatchCommand(manager: SessionManager, command: Command): Promise<void> {
  switch (command.type) {
    case 'start_session':
      throw new Error('start_session must be issued locally, not dispatched as a Command');
    case 'inject_prompt':
      manager.getSession(command.sessionId).injectPrompt(command.text);
      return;
    case 'respond_to_permission':
      manager
        .getSession(command.sessionId)
        .respondToPermission(command.requestId, { approved: command.approved, reason: command.reason });
      return;
    case 'pause':
      await manager.getSession(command.sessionId).pause();
      return;
    case 'resume':
      manager.getSession(command.sessionId).resume();
      return;
    case 'stop':
      await manager.stopSession(command.sessionId);
      return;
    default: {
      const exhaustiveCheck: never = command;
      throw new Error(`Unhandled command type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export type DispatchWithAckResult = { ok: true } | { ok: false; message: string };

/**
 * Wraps dispatchCommand with the *delivery* signal a relay-originated command needs: `sendAck`
 * is called exactly once, with 'delivered' if dispatchCommand resolved or 'failed' (carrying the
 * error message) if it threw.
 *
 * This is deliberately a separate signal from the `command_failed` SessionEvent the caller
 * (main.ts) additionally raises on failure: `command_ack` is a one-shot delivery receipt routed
 * only to the browser that sent this exact commandId, while `command_failed` is a durable,
 * session-history entry visible to every browser watching the session. Both fire from the same
 * underlying error today — that's expected, not a duplication to collapse (see
 * CommandAckMessage's doc comment in @companion/protocol). The returned result lets the caller
 * decide independently whether/how to raise that second signal, without this function needing to
 * know anything about SessionEvent or sessionIds.
 */
export async function dispatchCommandWithAck(
  manager: SessionManager,
  command: Command,
  sendAck: (status: 'delivered' | 'failed', message?: string) => void
): Promise<DispatchWithAckResult> {
  try {
    await dispatchCommand(manager, command);
    sendAck('delivered');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendAck('failed', message);
    return { ok: false, message };
  }
}
