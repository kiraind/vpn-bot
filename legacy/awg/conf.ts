export type ConfSection = Record<string, string>

export interface ParsedConf {
  interface: ConfSection
  peers: ConfSection[]
}

function parseSection(block: string): ConfSection {
  const section: ConfSection = {}

  for(const line of block.split('\n')) {
    const trimmed = line.trim()

    if(!trimmed || trimmed.startsWith('[')) {
      continue
    }

    const eqIndex = trimmed.indexOf('=')

    if(eqIndex === -1) {
      continue
    }

    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()

    section[key] = value
  }

  return section
}

export function parseConf(text: string): ParsedConf {
  const blocks = text.split(/\n(?=\[)/).map(block => block.trim()).filter(Boolean)

  let interfaceSection: ConfSection = {}
  const peers: ConfSection[] = []

  for(const block of blocks) {
    if(block.startsWith('[Interface]')) {
      interfaceSection = parseSection(block)
    } else if(block.startsWith('[Peer]')) {
      peers.push(parseSection(block))
    }
  }

  return { interface: interfaceSection, peers }
}

function serializeSection(header: string, section: ConfSection): string {
  const lines = Object.entries(section).map(([key, value]) => `${key} = ${value}`)

  return [header, ...lines].join('\n')
}

export function serializeConf(conf: ParsedConf): string {
  const blocks = [
    serializeSection('[Interface]', conf.interface),
    ...conf.peers.map(peer => serializeSection('[Peer]', peer))
  ]

  return `${blocks.join('\n\n')}\n`
}
