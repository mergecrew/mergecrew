import express from 'express';
import { healthRouter } from './routes/health.js';

const app = express();
app.use('/healthz', healthRouter);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`listening on :${port}`);
});
