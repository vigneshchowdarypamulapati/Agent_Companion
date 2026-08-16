import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './session-manager.js';
import {
  StartSessionCommand,
  InjectPromptCommand,
  RespondToPermissionCommand,
} from '@companion/protocol';
import type { SessionEvent } from '@companion/protocol';
import { dispatchCommand } from './command-dispatcher.js';
import { tokensMatch } from './local-auth.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export interface HttpServerOptions {
  /** Bearer token every request must present. See local-auth.ts. */
  token: string;
}

/**
 * Rejects any request whose Host header isn't a loopback address on the
 * port this connection actually arrived on. This is the layer that defeats
 * DNS rebinding: a page served from an attacker-controlled hostname that
 * DNS-rebinds to 127.0.0.1 still causes the browser to send that original
 * hostname in the Host header, never "127.0.0.1" or "localhost" — only a
 * same-origin request to the real loopback address can pass this check.
 *
 * The allowed port is read from the socket the request arrived on
 * (`req.socket.localPort`), not from a config value threaded in at server
 * construction time, so the check is always correct for whatever port this
 * server is actually listening on and needs no coordination with callers
 * (including tests, which bind to an OS-assigned ephemeral port).
 */
function hostAllowlist() {
  return (req: Request, res: Response, next: NextFunction) => {
    const port = req.socket.localPort;
    const host = req.headers.host;
    const allowed = host === `127.0.0.1:${port}` || host === `[::1]:${port}` || host === `localhost:${port}`;
    if (!allowed) {
      res.status(403).end();
      return;
    }
    next();
  };
}

/** Rejects any request that doesn't present the correct `Authorization: Bearer <token>` header. */
function bearerAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!presented || !tokensMatch(presented, token)) {
      res.status(401).end();
      return;
    }
    next();
  };
}

export function createHttpServer(
  manager: SessionManager,
  eventLog: SessionEvent[],
  options: HttpServerOptions
): Express {
  const app = express();
  // Auth runs before body parsing (and before every route) so a request that
  // fails either check never reaches JSON parsing or SessionManager.
  app.use(hostAllowlist());
  app.use(bearerAuth(options.token));
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
