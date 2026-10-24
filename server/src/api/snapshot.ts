import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunDetail } from '@ddd/shared';
import { renderMarkdown } from '../report/markdown.js';
import { renderPdf } from '../report/pdf.js';
import { renderXlsx } from '../report/xlsx.js';

const safe = (text: string) => text.replace(/[^\w.-]+/g, '_');

/**
 * A copy of a finished report on disk: <data>/reports/<project>/iteration-<n>/report.{json,md,xlsx,pdf}.
 * It is written whatever the database mode, so a result is never lost, even on the in-memory demo database.
 * Returns the folder it wrote, or null when the run has no report yet.
 */
export const snapshotFolder = (dataDir: string, projectName: string, iteration: number) => path.join(dataDir, 'reports', safe(projectName), `iteration-${iteration}`);

export async function saveRunSnapshot(dataDir: string, detail: RunDetail): Promise<string | null> {
  if (!detail.report) return null;
  const folder = snapshotFolder(dataDir, detail.projectName, detail.iteration);
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(path.join(folder, 'report.json'), JSON.stringify(detail.report, null, 2)),
    writeFile(path.join(folder, 'report.md'), renderMarkdown(detail.report)),
    renderXlsx(detail.report).then((bytes) => writeFile(path.join(folder, 'report.xlsx'), bytes)),
    renderPdf(detail.report).then((bytes) => writeFile(path.join(folder, 'report.pdf'), bytes)),
  ]);
  return folder;
}
