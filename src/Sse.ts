export type Message = { data?: string; event?: string; id?: string }

export function parse(text: string): { messages: Message[]; rest: string } {
  const blocks = text.split('\n\n')
  const rest = blocks.pop() ?? ''
  const messages: Message[] = []
  for (const block of blocks) {
    const message: Message = {}
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':')
      if (colon < 1) continue
      const field = line.slice(0, colon)
      const value = line.slice(colon + 1).replace(/^ /, '')
      if (field === 'data')
        message.data = message.data === undefined ? value : message.data + '\n' + value
      else if (field === 'event' || field === 'id') message[field] = value
    }
    if (Object.keys(message).length) messages.push(message)
  }
  return { messages, rest }
}
