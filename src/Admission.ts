export type Capacity = {
  memoryMb: number
  slots: number
}

export type Load = {
  memoryMb: number
  running: number
}

export function clamp(requestedMemoryMb: number, capacity: Capacity): number {
  return Math.min(requestedMemoryMb, capacity.memoryMb)
}

export function admits(load: Load, capacity: Capacity, requestedMemoryMb: number): boolean {
  return (
    load.running < capacity.slots &&
    load.memoryMb + clamp(requestedMemoryMb, capacity) <= capacity.memoryMb
  )
}

export function place<S extends { load: Load; capacity: Capacity }>(
  sandboxes: readonly S[],
  requestedMemoryMb: number,
): S | undefined {
  return sandboxes.find((sandbox) => admits(sandbox.load, sandbox.capacity, requestedMemoryMb))
}
