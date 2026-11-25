// Shared upload + inspect flow for backups and app transfers. Files above 16 MB are streamed in 16 MB binary chunks
// so reverse-proxy body limits (such as Cloudflare's 100 MB cap) and per-request timeouts never abort large archives.

export const BACKUP_CHUNK_SIZE = 16 * 1024 * 1024;
export const BACKUP_CHUNK_THRESHOLD = 16 * 1024 * 1024;

const RETRYABLE_HTTP = new Set([408, 429, 502, 503, 504]);
const MAX_CHUNK_RETRIES = 2;
const MAX_OFFSET_RESETS = 3;
// 409 UPLOAD_BUSY: the server still holds the stream of an attempt the client already gave up on (a dropped connection
// it has not noticed yet, a client timeout). It ends that stream soon and rolls back, or keeps the piece if it arrived
// whole (then the next try answers OFFSET_MISMATCH and moves on), so wait a little longer each time: 0.5 s … 3 s.
const MAX_BUSY_RETRIES = 6;
const BUSY_WAIT_MS = 500;

/** A 429 (a proxy's or the server's rate limit) waits as long as Retry-After says, 2 s at least and 30 s at most. */
const rateLimitWait = (res) => {
  const seconds = Number(res?.res?.headers?.get?.('Retry-After'));
  return Math.min(30000, Math.max(2000, Number.isFinite(seconds) ? seconds * 1000 : 0));
};

const isAbort = (err, signal) => Boolean(signal?.aborted || err?.name === 'AbortError');

function abortError() {
  if (typeof DOMException !== 'undefined') return new DOMException('', 'AbortError');
  const err = new Error('');
  err.name = 'AbortError';
  return err;
}

function waitMs(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function fileLength(file) {
  const n = Number(file?.size ?? file?.byteLength ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sliceChunk(file, start, end, type = 'application/octet-stream') {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file.slice(start, end, type);
  if (typeof file?.subarray === 'function') return new Blob([file.subarray(start, end)], { type });
  if (typeof file?.slice === 'function') {
    const part = file.slice(start, end, type);
    return typeof Blob !== 'undefined' && part instanceof Blob ? part : new Blob([part], { type });
  }
  return new Blob([file], { type });
}

function buildForm(file, filename) {
  const form = new FormData();
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    form.append('backup', file);
  } else {
    form.append('backup', sliceChunk(file, 0, fileLength(file), 'application/zip'), filename || 'backup.zip');
  }
  return form;
}

const isRetryableChunkError = (err) => {
  if (!err || typeof err !== 'object') return false;
  return Boolean(err.isNetwork || err.isTimeout || err.code === 'NETWORK' || err.code === 'TIMEOUT' || err instanceof TypeError);
};

/**
 * Uploads a backup File/Blob/Uint8Array (multipart for <= threshold, chunked otherwise) and triggers /api/backup/inspect.
 * `request` supplies `{ postForm, postJson, putChunk, deleteUpload }`, each resolving to `{ ok, status, data, res }`.
 */
export async function uploadAndInspectBackup({
  file,
  filename = null,
  request,
  signal,
  onPhase,
  onProgress,
  threshold = BACKUP_CHUNK_THRESHOLD,
  chunkSize: requestedChunkSize = BACKUP_CHUNK_SIZE
}) {
  const total = fileLength(file);
  const resolvedName = filename || (typeof file?.name === 'string' && file.name) || 'backup.zip';

  if (total <= threshold) {
    onPhase?.('inspect');
    return request.postForm('/api/backup/inspect', buildForm(file, resolvedName));
  }

  onPhase?.('upload');
  onProgress?.({ loaded: 0, total });

  const init = await request.postJson('/api/backup/uploads', { size: total, filename: resolvedName }, 'write');
  if (!init.ok) {
    // older servers (before chunked uploads) answer 404/405: send the whole file in one request as before
    if (init.status === 404 || init.status === 405) {
      onPhase?.('inspect');
      return request.postForm('/api/backup/inspect', buildForm(file, resolvedName));
    }
    return init;
  }

  const uploadId = init.data?.upload_id;
  if (!uploadId) return { ok: false, status: init.status || 500, data: init.data || {}, res: init.res };

  const deleteUrl = `/api/backup/uploads/${encodeURIComponent(uploadId)}`;
  let uploadConsumed = false;
  const cleanup = () => {
    if (!uploadConsumed) request.deleteUpload?.(deleteUrl);
  };

  try {
    if (signal?.aborted) throw abortError();
    const serverChunk = Number(init.data?.chunk_size);
    const step = Math.max(1, Math.min(requestedChunkSize, Number.isFinite(serverChunk) && serverChunk > 0 ? serverChunk : requestedChunkSize));

    let offset = 0;
    let offsetResets = 0;
    while (offset < total) {
      if (signal?.aborted) throw abortError();
      const end = Math.min(total, offset + step);
      const chunk = sliceChunk(file, offset, end);

      let chunkDone = false;
      let busyRetries = 0;
      for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
        if (signal?.aborted) throw abortError();
        let res;
        try {
          res = await request.putChunk(`${deleteUrl}?offset=${offset}`, chunk);
        } catch (err) {
          if (isAbort(err, signal)) throw err;
          if (attempt < MAX_CHUNK_RETRIES && isRetryableChunkError(err)) {
            await waitMs(400 * (attempt + 1), signal);
            continue;
          }
          throw err;
        }

        if (res.ok) {
          const received = Number(res.data?.received);
          offset = Number.isSafeInteger(received) && received >= end ? Math.min(total, received) : end;
          onProgress?.({ loaded: offset, total });
          chunkDone = true;
          break;
        }

        if (res.status === 409 && res.data?.code === 'OFFSET_MISMATCH' && Number.isSafeInteger(res.data?.expected)
          && res.data.expected >= 0 && res.data.expected <= total && res.data.expected !== offset && offsetResets < MAX_OFFSET_RESETS) {
          offset = res.data.expected;
          offsetResets++;
          onProgress?.({ loaded: offset, total });
          chunkDone = true;
          break;
        }

        if (res.status === 409 && res.data?.code === 'UPLOAD_BUSY' && busyRetries < MAX_BUSY_RETRIES) {
          busyRetries++;
          await waitMs(BUSY_WAIT_MS * busyRetries, signal);
          attempt--; // a busy answer does not use up one of the retries for failed requests
          continue;
        }

        if (RETRYABLE_HTTP.has(res.status) && attempt < MAX_CHUNK_RETRIES) {
          await waitMs(res.status === 429 ? rateLimitWait(res) : 400 * (attempt + 1), signal);
          continue;
        }

        if (res.status === 401 || res.status === 404) uploadConsumed = true;
        return res;
      }

      if (!chunkDone) return { ok: false, status: 500, data: {}, res: null };
    }

    if (signal?.aborted) throw abortError();
    onPhase?.('inspect');
    uploadConsumed = true;
    return await request.postJson('/api/backup/inspect', { upload_id: uploadId }, 'inspect');
  } catch (err) {
    if (isAbort(err, signal)) request.deleteUpload?.(deleteUrl);
    else cleanup();
    throw err;
  } finally {
    cleanup();
  }
}
