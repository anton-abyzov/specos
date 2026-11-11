/** Dragging a home file between windows: one MIME type carrying its home relative path. */
export const SPECOS_PATH_MIME = 'application/x-specos-path';

export function writeDragPath(transfer: DataTransfer, path: string): void {
  transfer.setData(SPECOS_PATH_MIME, path);
  transfer.setData('text/plain', path);
}

/** True while a home file is being dragged over; the payload itself is only readable on drop. */
export function hasDragPath(transfer: DataTransfer | null): boolean {
  return !!transfer && transfer.types.includes(SPECOS_PATH_MIME);
}

export function readDragPath(transfer: DataTransfer | null): string | null {
  return transfer?.getData(SPECOS_PATH_MIME) || null;
}
