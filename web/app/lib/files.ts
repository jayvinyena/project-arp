// 프로젝트 파일 열기·저장 (docs/02-file-format.md)
// 크롬·엣지: File System Access API로 같은 파일에 바로 저장. 그 밖: 올리기로 열고 다운로드로 저장.

export interface OpenedFile {
  name: string;
  bytes: ArrayBuffer;
  handle: FileSystemFileHandle | null;
  lastModified: number;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
};
const w = window as PickerWindow;
const TYPES = [{ description: 'ARP 프로젝트', accept: { 'application/x-sqlite3': ['.arp'] } }];

export const canSaveInPlace = typeof w.showOpenFilePicker === 'function';

export async function pickFile(): Promise<OpenedFile | null> {
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: TYPES, multiple: false });
      const file = await handle.getFile();
      return { name: file.name, bytes: await file.arrayBuffer(), handle, lastModified: file.lastModified };
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return null;
      throw error;
    }
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.arp';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: await file.arrayBuffer(), handle: null, lastModified: file.lastModified } : null);
    };
    input.click();
  });
}

/** 옛 도구 시트(.xlsx) 고르기 */
export function pickXlsx(): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: await file.arrayBuffer() } : null);
    };
    input.click();
  });
}

export async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`파일을 받지 못했습니다 (${res.status})`);
  return res.arrayBuffer();
}

export async function fetchSample(name: string): Promise<OpenedFile> {
  const res = await fetch(`../${name}.arp`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`예시 파일을 받지 못했습니다 (${res.status})`);
  return { name: `${name}.arp`, bytes: await res.arrayBuffer(), handle: null, lastModified: Date.now() };
}

export class SaveConflictError extends Error {
  constructor() {
    super('다른 곳에서 파일이 바뀌었습니다');
    this.name = 'SaveConflictError';
  }
}

/** 열어 둔 파일에 덮어쓰기. 연 뒤에 다른 곳에서 바뀌었으면 쓰지 않고 SaveConflictError */
export async function saveInPlace(handle: FileSystemFileHandle, bytes: ArrayBuffer, knownLastModified: number): Promise<number> {
  const current = await handle.getFile();
  if (current.lastModified !== knownLastModified) throw new SaveConflictError();
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return (await handle.getFile()).lastModified;
}

/** 다른 이름으로 저장. 파일 API가 없으면 다운로드 */
export async function saveAs(bytes: ArrayBuffer, suggestedName: string): Promise<{ handle: FileSystemFileHandle | null; lastModified: number; name: string } | null> {
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: TYPES });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      const file = await handle.getFile();
      return { handle, lastModified: file.lastModified, name: file.name };
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return null;
      throw error;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-sqlite3' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { handle: null, lastModified: Date.now(), name: suggestedName };
}
