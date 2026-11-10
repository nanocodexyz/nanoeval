export type Capacity = {
  freeDiskMb?: number
  memoryMb: number
  slots: number
}

export type Load = {
  freeDiskMb?: number
  memoryMb: number
  running: number
  starting?: number
}

export function clamp(requestedMemoryMb: number, capacity: Capacity): number {
  return Math.min(requestedMemoryMb, capacity.memoryMb)
}

export function admits(load: Load, capacity: Capacity, requestedMemoryMb: number): boolean {
  return (
    load.running < capacity.slots &&
    load.memoryMb + clamp(requestedMemoryMb, capacity) <= capacity.memoryMb &&
    (capacity.freeDiskMb === undefined ||
      (!load.starting && (load.freeDiskMb ?? 0) >= capacity.freeDiskMb))
  )
}

export function place<S extends { load: Load; capacity: Capacity }>(
  sandboxes: readonly S[],
  requestedMemoryMb: number,
): S | undefined {
  return sandboxes.find((sandbox) => admits(sandbox.load, sandbox.capacity, requestedMemoryMb))
}
