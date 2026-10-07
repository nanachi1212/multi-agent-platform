import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { getPortOccupant, isSafeTempDir } from './runtime-registry.mjs';

/**
 * Returns isolated data directory under %TEMP%\MultiAgentStudio\<project>\<run-id>\data
 * Ensures all lock files, cache, and state are completely separated from production ./data.
 */
export function getIsolatedDataDir(project, runId) {
  const projectSlug = path.basename(project || 'default').replace(/[^\w-]/g, '_') || 'default';
  const safeRunId = String(runId || Date.now()).replace(/[^\w-]/g, '_') || 'run';
  const projectRoot = path.join(os.tmpdir(), 'MultiAgentStudio', projectSlug);
  fs.mkdirSync(projectRoot, { recursive: true });
  if (!isSafeTempDir(path.join(projectRoot, safeRunId + '-pending'))) throw new Error('Unsafe smoke temp directory');
  const tempRoot = fs.mkdtempSync(path.join(projectRoot, safeRunId + '-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { dataDir, tempRoot };
}

/**
 * Check if a port can be bound and is not occupied.
 * Strictly avoids official production ports 3018 (backend) and 3011 (frontend).
 */
export async function isPortAvailable(port) {
  if (port === 3018 || port === 3011) return false;
  const occupant = await getPortOccupant(port);
  if (occupant) return false;

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Dynamically allocate an isolated port in range (default: 3020-3099),
 * strictly avoiding production 3018 and 3011.
 */
export async function allocateIsolatedPort(preferredPort = 3020, range = [3020, 3099]) {
  if (preferredPort !== 3018 && preferredPort !== 3011 && (await isPortAvailable(preferredPort))) {
    return preferredPort;
  }
  const [min, max] = range;
  for (let p = min; p <= max; p++) {
    if (p === 3018 || p === 3011 || p === preferredPort) continue;
    if (await isPortAvailable(p)) {
      return p;
    }
  }

  // Fallback to OS assigned ephemeral port
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Setup isolated smoke/test environment:
 * - DATA_DIR pointing to %TEMP%\MultiAgentStudio\<project>\<run-id>\data
 * - Dynamic port allocation avoiding 3018/3011
 * - Cleanup function for after test run
 */
export async function createSmokeEnvironment({
  project,
  runId,
  cardId = null,
  baseEnv = process.env,
  preferredPort = 3020
} = {}) {
  const port = await allocateIsolatedPort(preferredPort);
  const { dataDir, tempRoot } = getIsolatedDataDir(project, runId);

  const env = {
    ...baseEnv,
    DATA_DIR: dataDir,
    PORT: String(port),
    STUDIO_ISOLATED: '1',
    STUDIO_RUN_ID: String(runId || '')
  };

  return {
    dataDir,
    tempRoot,
    port,
    env,
    cleanup: () => {
      cleanupIsolatedDir(tempRoot);
    }
  };
}

export function cleanupIsolatedDir(tempRoot) {
  if (!tempRoot || typeof tempRoot !== 'string') return;
  const resolved = path.resolve(tempRoot);
  if (isSafeTempDir(resolved)) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {}
  }
}
