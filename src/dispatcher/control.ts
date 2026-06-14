// Control commands bypass the workflow queue and are handled immediately (D12).

export type ControlCommand = 'status' | 'cancel' | 'done';

export function parseControl(text: string): ControlCommand | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'status') return 'status';
  if (normalized === 'cancel' || normalized === 'stop' || normalized === 'abort') return 'cancel';
  if (normalized === 'done' || normalized === 'close') return 'done';
  return undefined;
}
