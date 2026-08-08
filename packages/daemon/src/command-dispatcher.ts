import type { Command } from '@companion/protocol';
import type { SessionManager } from './session-manager.js';

/**
 * Applies a Command to the given SessionManager. Shared by the local HTTP
 * control surface (http-server.ts) and the relay client's incoming-command
 * handler (relay-client.ts via main.ts), so the two channels apply commands
 * identically and can never drift.
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
