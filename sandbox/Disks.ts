export function idle(
  names: readonly string[],
  input: { held: ReadonlySet<string>; mark: string },
): string[] {
  return names
    .filter((name) => name.endsWith(input.mark))
    .map((name) => name.slice(0, -input.mark.length))
    .filter((digest) => !input.held.has(digest) && names.includes(digest + '.ext4'))
    .sort()
}
