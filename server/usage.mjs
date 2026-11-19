import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_LIMIT = 5;
export const SESSION_WINDOW_MS = 60 * 60 * 1000;

const COOKIE_NAME = 'mpl_session';

export function readSessionCookie(header = '') {
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(id, { secure = false } = {}) {
  return `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

function positiveInteger(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function usageConfig(env = process.env) {
  const mode = env.APP_MODE === undefined ? 'development' : env.APP_MODE.trim();
  const modeValid = mode === 'development' || mode === 'public';
  const hasMax = env.DEMO_MAX_GENERATIONS !== undefined;
  const parsedMax = hasMax ? positiveInteger(env.DEMO_MAX_GENERATIONS) : null;
  const budgetFile = env.DEMO_BUDGET_FILE === undefined
    ? '.data/generation-budget.json'
    : env.DEMO_BUDGET_FILE.trim();

  return {
    mode,
    modeValid,
    generationEnabled: env.GENERATION_ENABLED?.trim().toLowerCase() !== 'false',
    maxGenerations: parsedMax,
    maxConfigured: hasMax,
    maxValid: hasMax ? parsedMax !== null : mode === 'development',
    budgetFile,
    budgetFileValid: Boolean(budgetFile),
  };
}

export function createFileBudgetStorage(filePath) {
  const absolutePath = path.resolve(filePath);
  return {
    persistent: true,
    async load() {
      let contents;
      try {
        contents = await readFile(absolutePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      const ledger = JSON.parse(contents);
      if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) ||
          Object.keys(ledger).sort().join(',') !== 'admitted,version' ||
          ledger.version !== 1 || !Number.isSafeInteger(ledger.admitted) || ledger.admitted < 0) {
        throw new Error('Invalid generation budget ledger.');
      }
      return ledger.admitted;
    },
    async save(admitted) {
      const directory = path.dirname(absolutePath);
      const temporaryPath = path.join(directory,
        `.${path.basename(absolutePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, admitted })}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, absolutePath);
      } finally {
        await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
  };
}

function errorResult(code) {
  const messages = {
    NOT_CONFIGURED: 'Exercise generation is currently unavailable.',
    GENERATION_PAUSED: 'New exercise generation is paused. The sample is still available.',
    BUDGET_NOT_CONFIGURED: 'Exercise generation is not available in this mode.',
    BUDGET_EXHAUSTED: 'The demo generation limit has been reached.',
    BUDGET_UNAVAILABLE: 'Exercise generation is temporarily unavailable.',
    SESSION_LIMIT: 'This browser has reached its hourly generation limit.',
    SERVER_BUSY: 'Two exercises are already being generated. Please try again shortly.',
  };
  return { code, error: messages[code] };
}

export function createUsageGate({
  config = usageConfig(),
  now = Date.now,
  idFactory = () => randomBytes(32).toString('base64url'),
  sessionLimit = SESSION_LIMIT,
  windowMs = SESSION_WINDOW_MS,
  maxConcurrent = 2,
  storage,
} = {}) {
  config = {
    mode: 'development', modeValid: true, generationEnabled: true,
    maxGenerations: null, maxValid: true, budgetFile: '', budgetFileValid: false,
    ...config,
  };
  const persistentRequired = config.maxGenerations !== null || config.mode === 'public';
  const counterStorage = storage ?? (persistentRequired && config.budgetFileValid
    ? createFileBudgetStorage(config.budgetFile)
    : null);
  const sessions = new Map();
  let active = 0;
  let admitted = 0;
  let ledgerLoaded = false;
  let ledgerFailed = false;
  let lock = Promise.resolve();

  function serialize(operation) {
    const result = lock.then(operation, operation);
    lock = result.catch(() => {});
    return result;
  }

  function pruneSessions(at) {
    const cutoff = at - windowMs;
    for (const [id, timestamps] of sessions) {
      const recent = timestamps.filter(timestamp => timestamp > cutoff);
      if (recent.length) sessions.set(id, recent);
      else sessions.delete(id);
    }
  }

  async function ensureLedger() {
    if (!persistentRequired) return true;
    if (ledgerFailed || !counterStorage || counterStorage.persistent !== true) return false;
    if (ledgerLoaded) return true;
    try {
      const stored = await counterStorage.load();
      if (stored === null) {
        await counterStorage.save(0);
        admitted = 0;
      } else if (Number.isSafeInteger(stored) && stored >= 0) {
        admitted = stored;
      } else {
        throw new Error('Invalid generation budget ledger.');
      }
      ledgerLoaded = true;
      return true;
    } catch {
      ledgerFailed = true;
      return false;
    }
  }

  function serviceError() {
    if (!config.generationEnabled) return errorResult('GENERATION_PAUSED');
    if (!config.modeValid || !config.maxValid ||
        (config.mode === 'public' && config.maxGenerations === null)) {
      return errorResult('BUDGET_NOT_CONFIGURED');
    }
    return null;
  }

  async function status({ configured, cookieId = null } = {}) {
    const at = now();
    pruneSessions(at);
    if (!configured) return { available: false, ...errorResult('NOT_CONFIGURED') };
    const availabilityError = serviceError();
    if (availabilityError) return { available: false, ...availabilityError };
    if (!(await ensureLedger())) return { available: false, ...errorResult('BUDGET_UNAVAILABLE') };
    if (config.maxGenerations !== null && admitted >= config.maxGenerations) {
      return { available: false, ...errorResult('BUDGET_EXHAUSTED') };
    }
    const timestamps = sessions.get(cookieId);
    if (timestamps?.length >= sessionLimit) {
      const retryAt = new Date(Math.min(...timestamps) + windowMs).toISOString();
      return { available: false, ...errorResult('SESSION_LIMIT'), retryAt };
    }
    if (active >= maxConcurrent) return { available: false, ...errorResult('SERVER_BUSY') };
    return { available: true, code: null };
  }

  function retryResult(timestamps) {
    const retryAt = new Date(Math.min(...timestamps) + windowMs).toISOString();
    return { admitted: false, ...errorResult('SESSION_LIMIT'), retryAt };
  }

  return {
    mode: config.mode,
    status(options = {}) {
      return serialize(() => status(options));
    },
    admit({ configured, cookieId = null, isAborted = () => false } = {}) {
      return serialize(async () => {
        if (isAborted()) return { admitted: false, aborted: true };
        const at = now();
        pruneSessions(at);
        if (!configured) return { admitted: false, ...errorResult('NOT_CONFIGURED') };
        const availabilityError = serviceError();
        if (availabilityError) return { admitted: false, ...availabilityError };
        if (!(await ensureLedger())) return { admitted: false, ...errorResult('BUDGET_UNAVAILABLE') };
        if (config.maxGenerations !== null && admitted >= config.maxGenerations) {
          return { admitted: false, ...errorResult('BUDGET_EXHAUSTED') };
        }
        if (active >= maxConcurrent) return { admitted: false, ...errorResult('SERVER_BUSY') };

        const existing = sessions.get(cookieId);
        if (existing?.length >= sessionLimit) return retryResult(existing);

        let sessionId = cookieId;
        const newSession = !existing;
        if (newSession) {
          do { sessionId = idFactory(); } while (sessions.has(sessionId));
        }

        const previous = admitted;
        const countGlobally = config.maxGenerations !== null;
        if (countGlobally) {
          try {
            await counterStorage.save(previous + 1);
          } catch {
            ledgerFailed = true;
            return { admitted: false, ...errorResult('BUDGET_UNAVAILABLE') };
          }
        }
        if (isAborted()) {
          if (countGlobally) {
            try {
              await counterStorage.save(previous);
            } catch {
              ledgerFailed = true;
              admitted = previous + 1;
            }
          }
          return { admitted: false, aborted: true };
        }
        if (countGlobally) {
          admitted = previous + 1;
        }

        if (newSession) sessions.set(sessionId, []);
        sessions.get(sessionId).push(at);
        active++;
        let released = false;
        return {
          admitted: true,
          sessionId,
          newSession,
          release() {
            if (released) return;
            released = true;
            active--;
          },
        };
      });
    },
  };
}
