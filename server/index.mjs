import { createApp } from './app.mjs';
import { isModelConfigured, modelConfig } from './model.mjs';
import { createUsageGate, usageConfig } from './usage.mjs';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4318);
const config = modelConfig();
const app = createApp({ config, usage: createUsageGate({ config: usageConfig() }) });
app.listen(port, host, () => {
  console.log(`Math Play Lab: http://${host}:${port}`);
  console.log(isModelConfigured(config) ? 'Model configuration present.' : 'Model not configured. Prebuilt samples are available.');
});
app.on('error', error => { console.error(`Could not start server: ${error.code || 'unknown error'}`); process.exitCode=1; });
