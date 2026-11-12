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

export type Offer = {
  capacityMb: number
  memoryMb: number
  slots: number
}

export function clamp(requestedMemoryMb: number, capacity: Pick<Capacity, 'memoryMb'>): number {
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

export function starved(load: Load, capacity: Capacity): boolean {
  return (
    capacity.freeDiskMb !== undefined &&
    !load.running &&
    (load.freeDiskMb ?? 0) < capacity.freeDiskMb
  )
}

export function offer(load: Load, capacity: Capacity): Offer {
  const blocked =
    capacity.freeDiskMb !== undefined &&
    (Boolean(load.starting) || (load.freeDiskMb ?? 0) < capacity.freeDiskMb)
  const free = Math.max(0, capacity.slots - load.running)
  return {
    capacityMb: capacity.memoryMb,
    memoryMb: Math.max(0, capacity.memoryMb - load.memoryMb),
    slots: blocked ? 0 : capacity.freeDiskMb === undefined ? free : Math.min(free, 1),
  }
}

export function fill<T>(candidates: readonly { item: T; memoryMb: number }[], offered: Offer): T[] {
  const chosen: T[] = []
  let memoryMb = offered.memoryMb
  const whole = (candidate: { memoryMb: number }) => candidate.memoryMb >= offered.capacityMb
  const ordered =
    offered.memoryMb >= offered.capacityMb
      ? [...candidates.filter(whole), ...candidates.filter((candidate) => !whole(candidate))]
      : candidates
  for (const candidate of ordered) {
    if (chosen.length >= offered.slots) break
    const needed = Math.min(candidate.memoryMb, offered.capacityMb)
    if (needed > memoryMb) continue
    memoryMb -= needed
    chosen.push(candidate.item)
  }
  return chosen
}
