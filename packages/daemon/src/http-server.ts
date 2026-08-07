import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './session-manager.js';
import type { SessionEvent } from '@companion/protocol';

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
      const { projectPath, prompt } = req.body as { projectPath: string; prompt: string };
      const runner = manager.startSession(projectPath, prompt);
      res.status(201).json({ id: runner.id, status: runner.status });
    })
  );

  app.post(
    '/sessions/:id/prompt',
    asyncHandler(async (req, res) => {
      const { text } = req.body as { text: string };
      manager.getSession(req.params.id).injectPrompt(text);
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/respond',
    asyncHandler(async (req, res) => {
      const { requestId, approved, reason } = req.body as {
        requestId: string;
        approved: boolean;
        reason?: string;
      };
      manager.getSession(req.params.id).respondToPermission(requestId, { approved, reason });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/pause',
    asyncHandler(async (req, res) => {
      await manager.getSession(req.params.id).pause();
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/resume',
    asyncHandler(async (req, res) => {
      manager.getSession(req.params.id).resume();
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/stop',
    asyncHandler(async (req, res) => {
      await manager.stopSession(req.params.id);
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
