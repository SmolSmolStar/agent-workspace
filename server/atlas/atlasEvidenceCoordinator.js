const EVIDENCE_QUEUE_FULL_CODE = 'ATLAS_EVIDENCE_QUEUE_FULL';

function createEvidenceCoordinator({ maxConcurrent = 2, maxQueued = 32 } = {}) {
  const limit = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2;
  const queueLimit = Number.isInteger(maxQueued) && maxQueued > 0 ? maxQueued : 32;
  const inFlight = new Map();
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  const run = (key, task) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new Error('Evidence task key is required.');
    if (typeof task !== 'function') throw new Error('Evidence task must be a function.');

    const existing = inFlight.get(normalizedKey);
    if (existing) return existing;
    if (queue.length >= queueLimit) {
      const error = new Error('Repository evidence queue is full.');
      error.code = EVIDENCE_QUEUE_FULL_CODE;
      return Promise.reject(error);
    }

    const promise = new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
    const clear = () => {
      if (inFlight.get(normalizedKey) === promise) inFlight.delete(normalizedKey);
    };
    promise.then(clear, clear);
    inFlight.set(normalizedKey, promise);
    return promise;
  };

  return {
    run,
    state: () => ({ active, queued: queue.length, inFlight: inFlight.size })
  };
}

module.exports = { createEvidenceCoordinator, EVIDENCE_QUEUE_FULL_CODE };
