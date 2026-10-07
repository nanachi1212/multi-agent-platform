import net from 'node:net';

const startupError = (body) => body?.startup_error || body?.error || body?.reason || body?.detail || '';

export function isApplicationReady(body) {
  return body?.ready === true || body?.status === 'ready';
}

export async function checkBackendReadiness(runtime, {
  isPidAlive = () => false,
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
  const applicationReady = health?.httpStatus === 200 && isApplicationReady(health.body);
  const ready = alive && reachable && applicationReady;
  const detail = startupError(health?.body);
  const reason = ready ? '' : [
    !alive ? `process ${runtime?.root_pid || 'unknown'} is not alive` : '',
    !reachable ? `port ${runtime?.port || 'unknown'} is not reachable` : '',
    reachable && health?.httpStatus !== 200 ? `/health returned HTTP ${health?.httpStatus ?? 'error'}${detail ? `: ${detail}` : healthError ? `: ${healthError}` : ''}` : '',
    reachable && health?.httpStatus === 200 && !applicationReady ? (detail || '/health did not report ready') : ''
  ].filter(Boolean).join('; ');
  return {
    status: ready ? 'BACKEND_READY' : 'BLOCKED',
    process_alive: alive,
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
  continueJob
}) {
  const blocked = (reason) => ({ status: 'blocked', reason });
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

  await cleanup(runtime);
  const replacement = await restart(runtime);
  const ready = await readiness(replacement);
  if (ready?.status !== 'BACKEND_READY') return blocked(ready?.reason || 'backend did not become ready');
  const smokeResult = await smoke(replacement);
  if (smokeResult?.ok !== true) return blocked(smokeResult?.reason || 'smoke check failed');
  await continueJob(runtime.job_id, runtime.card_id);
  return { status: 'recovered', runtime: replacement, smoke: smokeResult };
}
