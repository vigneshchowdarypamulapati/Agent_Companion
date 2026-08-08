import type { Command } from '@companion/protocol';

export interface PermissionPromptProps {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  onSend: (command: Command) => void;
}

export default function PermissionPrompt({ sessionId, requestId, toolName, input, onSend }: PermissionPromptProps) {
  function respond(approved: boolean) {
    onSend({ type: 'respond_to_permission', sessionId, requestId, approved });
  }

  return (
    <div className="bg-amber-900/40 border border-amber-700 rounded-md p-4 space-y-2">
      <p className="font-medium">Claude wants to use {toolName}</p>
      <pre className="text-xs bg-slate-800 rounded p-2 overflow-x-auto">{JSON.stringify(input, null, 2)}</pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => respond(true)}
          className="flex-1 rounded-md bg-green-700 px-3 py-2 text-sm font-medium"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => respond(false)}
          className="flex-1 rounded-md bg-red-700 px-3 py-2 text-sm font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
