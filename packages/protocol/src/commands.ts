import { z } from 'zod';

export const StartSessionCommand = z.object({
  type: z.literal('start_session'),
  projectPath: z.string(),
  prompt: z.string(),
});

export const InjectPromptCommand = z.object({
  type: z.literal('inject_prompt'),
  sessionId: z.string(),
  text: z.string(),
});

export const RespondToPermissionCommand = z.object({
  type: z.literal('respond_to_permission'),
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const PauseCommand = z.object({
  type: z.literal('pause'),
  sessionId: z.string(),
});

export const ResumeCommand = z.object({
  type: z.literal('resume'),
  sessionId: z.string(),
});

export const StopCommand = z.object({
  type: z.literal('stop'),
  sessionId: z.string(),
});

export const Command = z.discriminatedUnion('type', [
  StartSessionCommand,
  InjectPromptCommand,
  RespondToPermissionCommand,
  PauseCommand,
  ResumeCommand,
  StopCommand,
]);
export type Command = z.infer<typeof Command>;
