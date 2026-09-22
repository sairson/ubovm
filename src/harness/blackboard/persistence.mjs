import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

// Keep the old snapshot intact until the entire replacement is written and synced.
export async function writeSnapshot(filePath, snapshot) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${directory}/.${basename(filePath)}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, filePath);
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
