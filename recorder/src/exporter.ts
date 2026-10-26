// Writes a session's files to a folder the user picks (File System Access API, needs a secure page: http://localhost
// counts), or downloads a zip when that is not available or the user prefers it.
import { zipSync } from 'fflate';
import { buildSessionFiles, type SessionFiles } from './csv';
import type { SessionRec, StoredPacket } from './types';

export const APP_VERSION = '0.1.0';

declare global {
  interface Window { showDirectoryPicker?: (o?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>; }
}

export const canWriteFolder = (): boolean => typeof window.showDirectoryPicker === 'function';

export interface ExportResult { method: 'folder' | 'zip'; where: string; summary: SessionFiles['summary']; files: number }

export async function exportToFolder(session: SessionRec, packets: StoredPacket[]): Promise<ExportResult> {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot write to a folder; use the zip export.');
  const out = buildSessionFiles(session, packets, APP_VERSION);
  const root = await window.showDirectoryPicker({ mode: 'readwrite' });
  const dir = await root.getDirectoryHandle(session.id, { create: true });
  for (const [name, parts] of out.files) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    for (const p of parts) await w.write(p);
    await w.close();
  }
  return { method: 'folder', where: `${root.name}/${session.id}`, summary: out.summary, files: out.files.size };
}

export async function exportToZip(session: SessionRec, packets: StoredPacket[]): Promise<ExportResult> {
  const out = buildSessionFiles(session, packets, APP_VERSION);
  const entries: Record<string, Uint8Array> = {};
  for (const [name, parts] of out.files) entries[`${session.id}/${name}`] = new Uint8Array(await new Blob(parts).arrayBuffer());
  const blob = new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${session.id}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return { method: 'zip', where: `${session.id}.zip (your Downloads folder)`, summary: out.summary, files: out.files.size };
}
