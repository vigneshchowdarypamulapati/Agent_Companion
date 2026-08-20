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
          {event.type === 'adopted_history' ? <AdoptedHistoryBlock event={event} /> : describeEvent(event)}
        </li>
      ))}
    </ul>
  );
}

function AdoptedHistoryBlock({ event }: { event: Extract<SessionEvent, { type: 'adopted_history' }> }) {
  return (
    <div className="space-y-1 border-l-2 border-border pl-2">
      <p className="text-xs font-medium text-ink-faint uppercase tracking-wide">Prior conversation</p>
      {event.truncated && (
        <p className="text-xs text-ink-faint italic">Showing the most recent 50 messages of a longer conversation</p>
      )}
      <ul className="space-y-1">
        {event.messages.map((message, index) => (
          <li key={index} className="text-sm text-ink-muted">
            <span className="font-medium">{message.role === 'user' ? 'You' : 'Claude'}:</span> {message.text}
          </li>
        ))}
      </ul>
    </div>
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
      // Never reached — the .map() above renders AdoptedHistoryBlock for this type before
      // describeEvent is ever called on it. Exists only so this switch stays exhaustive.
      return `Resumed from an earlier session (${event.messages.length} prior messages)`;
  }
}
