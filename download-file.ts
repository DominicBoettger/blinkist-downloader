import { randomUUID } from 'node:crypto';
import { rm, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

class DownloadError extends Error {}

/** Publish only a complete response; keep signed sources out of errors. */
export async function downloadFile(url: string, path: string): Promise<void> {
  const partial = join(dirname(path), `.${basename(path)}.${randomUUID()}.part`);
  try {
    const response = await fetch(url, {
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new DownloadError(`File transfer returned HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new DownloadError('File transfer was empty');
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding')?.toLowerCase();
    if (length !== null && (!encoding || encoding === 'identity') &&
        (!/^\d+$/.test(length) || Number(length) !== bytes.length)) {
      throw new DownloadError('File transfer was incomplete');
    }
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    // Fetch exceptions can contain the signed URL. Preserve only our own
    // diagnostics and never expose the underlying exception or its cause.
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('File transfer failed');
  } finally {
    await rm(partial, { force: true }).catch(() => {});
  }
}
