export interface AgentMessage {
  type: string;
  [key: string]: unknown;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface PermissionResponse {
  approved: boolean;
  reason?: string;
}

export interface AgentQuery extends AsyncIterable<AgentMessage> {
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentQueryOptions {
  cwd: string;
  canUseTool: (request: PermissionRequest) => Promise<PermissionResponse>;
}

export type QueryFn = (args: {
  prompt: AsyncIterable<{ type: 'user'; text: string }>;
  options: AgentQueryOptions;
}) => AgentQuery;
