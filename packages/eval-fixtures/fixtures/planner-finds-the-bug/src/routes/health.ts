import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  // BUG: missing return + body — handler hangs forever
});
