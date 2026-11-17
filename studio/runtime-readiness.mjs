import net from 'node:net';
import { verifyRuntimeProcess, checkPortOwnership, isPidAlive as pidAlive } from './runtime-registry.mjs';

const startupError = (body) => body?.startup_error || body?.error || body?.reason || body?.detail || '';

export function isApplicationReady(body) {
  if (body?.ready === false || startupError(body)) return false;
  return body?.ready === true || body?.status === 'ready' || body?.status === 'ok';
}

export async function checkBackendReadiness(runtime, {
  isPidAlive = pidAlive,
  verifyOwnership = async (record) => {
    const process = await verifyRuntimeProcess(record);
    if (!process.ok || !process.alive) return { ok: false, reason: process.reason || 'runtime process is not alive' };
    const port = await checkPortOwnership(record.port, { desiredJobId: record.job_id, desiredDataDir: record.data_dir, rtDir: record.rtDir });
    return { ok: port.owner === 'studio' && port.runtime?.runtime_id === record.runtime_id,
      reason: port.reason || `port ${record.port} does not belong to runtime ${record.runtime_id}` };
  },
  portReachable = (port) => new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  }),
  getHealth = async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return { httpStatus: response.status, body: await response.json().catch(() => ({})) };
  }
} = {}) {
  const alive = !!runtime?.root_pid && isPidAlive(runtime.root_pid);
  const reachable = !!runtime?.port && await portReachable(runtime.port);
  let health = null;
  let healthError = '';
  if (reachable) {
    try { health = await getHealth(runtime.port); }
    catch (error) { healthError = error?.message || String(error); }
  }
  let ownership = { ok: false };
  if (alive && reachable) {
    try { ownership = await verifyOwnership(runtime); }
    catch (error) { ownership = { ok: false, reason: `runtime ownership check failed: ${error?.message || String(error)}` }; }
  }
  const applicationReady = health?.httpStatus === 200 && isApplicationReady(health.body);
  const ready = alive && reachable && ownership.ok && applicationReady;
  const detail = startupError(health?.body);
  const reason = ready ? '' : [
    alive && reachable && !ownership.ok ? ownership.reason || 'runtime ownership is unverified' : '',
    !alive ? `process ${runtime?.root_pid || 'unknown'} is not alive` : '',
    !reachable ? `port ${runtime?.port || 'unknown'} is not reachable` : '',
    reachable && health?.httpStatus !== 200 ? `/health returned HTTP ${health?.httpStatus ?? 'error'}${detail ? `: ${detail}` : healthError ? `: ${healthError}` : ''}` : '',
    reachable && health?.httpStatus === 200 && !applicationReady ? (detail || '/health did not report ready') : ''
  ].filter(Boolean).join('; ');
  return {
    status: ready ? 'BACKEND_READY' : 'BLOCKED',
    process_alive: alive,
    ownership_verified: !!ownership.ok,
    port_reachable: reachable,
    health_http_status: health?.httpStatus ?? null,
    application_ready: applicationReady,
    startup_error: detail || null,
    reason
  };
}

/** Run the safe automatic recovery sequence only for a known Studio runtime and data owner. */
export async function recoverOwnedRuntime(runtime, {
  workspace,
  dataDir,
  cleanup,
  restart,
  readiness,
  smoke,
  continueJob,
  canProceed = () => true
}) {
  const blocked = (reason, manual = true) => ({ status: 'blocked', reason, manual });
  const cancelled = () => ({ status: 'cancelled', reason: 'job paused, stopped or ownership changed', manual: false });
  if (!runtime || runtime.created_by !== 'studio') return blocked('runtime owner is unknown; manual recovery required');
  if (!runtime.root_pid || !runtime.workspace || !runtime.data_dir) return blocked('runtime PID, workspace, or data owner is unknown; manual recovery required');
  if (runtime.restart_safe !== true || !runtime.executable || !Array.isArray(runtime.args) || !runtime.cwd) {
    return blocked('restart command or required credentials are not confirmed safe; manual recovery required');
  }
  if (workspace && runtime.workspace !== workspace) return blocked('runtime workspace does not match the job; manual recovery required');
  if (dataDir && runtime.data_dir !== dataDir) return blocked('runtime data owner does not match the job; manual recovery required');
  if (typeof cleanup !== 'function' || typeof restart !== 'function' || typeof readiness !== 'function'
      || typeof smoke !== 'function' || typeof continueJob !== 'function') {
    return blocked('recovery action is unavailable; manual recovery required');
  }

  if (!canProceed()) return cancelled();
  const cleaned = await cleanup(runtime);
  if (cleaned?.ok === false) return blocked(cleaned.reason || 'runtime cleanup was not confirmed');
  if (!canProceed()) return cancelled();
  const replacement = await restart(runtime);
  if (!canProceed()) { await cleanup(replacement); return cancelled(); }
  const ready = await readiness(replacement);
  if (!canProceed()) { await cleanup(replacement); return cancelled(); }
  if (ready?.status !== 'BACKEND_READY') return blocked(ready?.reason || 'backend did not become ready', false);
  const smokeResult = await smoke(replacement);
  if (smokeResult?.ok !== true) return blocked(smokeResult?.reason || 'smoke check failed', false);
  if (!canProceed()) { await cleanup(replacement); return cancelled(); }
  await continueJob(runtime.job_id, runtime.card_id);
  return { status: 'recovered', runtime: replacement, smoke: smokeResult };
}
