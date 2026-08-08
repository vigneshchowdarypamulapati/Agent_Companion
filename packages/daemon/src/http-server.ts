import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './session-manager.js';
import {
  StartSessionCommand,
  InjectPromptCommand,
  RespondToPermissionCommand,
} from '@companion/protocol';
import type { SessionEvent } from '@companion/protocol';
import { dispatchCommand } from './command-dispatcher.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function createHttpServer(manager: SessionManager, eventLog: SessionEvent[]): Express {
  const app = express();
  app.use(express.json());

  app.post(
    '/sessions',
    asyncHandler(async (req, res) => {
      const { projectPath, prompt } = StartSessionCommand.omit({ type: true }).parse(req.body);
      const runner = manager.startSession(projectPath, prompt);
      res.status(201).json({ id: runner.id, status: runner.status });
    })
  );

  app.post(
    '/sessions/:id/prompt',
    asyncHandler(async (req, res) => {
      const { text } = InjectPromptCommand.omit({ type: true, sessionId: true }).parse(req.body);
      await dispatchCommand(manager, { type: 'inject_prompt', sessionId: req.params.id, text });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/respond',
    asyncHandler(async (req, res) => {
      const { requestId, approved, reason } = RespondToPermissionCommand.omit({
        type: true,
        sessionId: true,
      }).parse(req.body);
      await dispatchCommand(manager, {
        type: 'respond_to_permission',
        sessionId: req.params.id,
        requestId,
        approved,
        reason,
      });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/pause',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'pause', sessionId: req.params.id });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/resume',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'resume', sessionId: req.params.id });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/stop',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'stop', sessionId: req.params.id });
      res.status(204).end();
    })
  );

  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const events = eventLog.filter((e) => e.sessionId === req.params.id);
      res.status(200).json(events);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  });

  return app;
}
