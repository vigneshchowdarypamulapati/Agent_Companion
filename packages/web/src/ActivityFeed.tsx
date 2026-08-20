import type { SessionEvent } from '@companion/protocol';

export interface ActivityFeedProps {
  events: SessionEvent[];
}

export default function ActivityFeed({ events }: ActivityFeedProps) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-faint">No activity yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {events.map((event, index) => (
        <li key={index} className="text-sm bg-panel rounded-md px-3 py-2">
          {describeEvent(event)}
        </li>
      ))}
    </ul>
  );
}

// The explicit `: string` return type is what makes this exhaustive: if a
// future SessionEvent variant is added without a case here, TypeScript
// reports "not all code paths return a value" rather than silently falling
// through — the same effect as command-dispatcher.ts's `never`-assignment
// guard, without the extra boilerplate.
function describeEvent(event: SessionEvent): string {
  switch (event.type) {
    case 'session_started':
      return `Session started in ${event.projectPath}`;
    case 'assistant_text':
      return event.text;
    case 'tool_use':
      return `Used ${event.toolName}`;
    case 'tool_result':
      return event.isError ? `${event.toolName} failed` : `${event.toolName} completed`;
    case 'permission_request':
      return `Requesting permission to use ${event.toolName}`;
    case 'permission_resolved':
      return event.approved ? 'Permission approved' : 'Permission denied';
    case 'turn_complete':
      return 'Turn complete';
    case 'error':
      return `Error: ${event.message}`;
    case 'command_failed':
      return `Command failed: ${event.message}`;
    case 'stopped':
      return 'Session stopped';
    case 'events_dropped':
      return 'Some activity was lost while disconnected from the relay';
    case 'adopted_history':
      return `Adopted ${event.messages.length} messages from previous session${event.truncated ? ' (truncated)' : ''}`;
  }
}
