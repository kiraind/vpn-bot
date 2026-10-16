// Minimal Prometheus text exposition format (version 0.0.4) writer.

export type Labels = Record<string, string>
export type MetricType = 'gauge' | 'counter'

interface Family {
  type: MetricType
  help: string
  samples: string[]
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function formatValue(value: number): string {
  if(Number.isNaN(value)) return 'NaN'
  if(value === Infinity) return '+Inf'
  if(value === -Infinity) return '-Inf'
  return String(value)
}

export class Exposition {
  private readonly families = new Map<string, Family>()

  /** Declares a family; families keep declaration order, so a declared but empty one still gets HELP/TYPE. */
  declare(name: string, type: MetricType, help: string): this {
    if(!this.families.has(name)) this.families.set(name, { type, help, samples: [] })
    return this
  }

  add(name: string, labels: Labels, value: number): this {
    const family = this.families.get(name)
    if(!family) throw new Error(`metric ${name} is not declared`)
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    family.samples.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${formatValue(value)}`)
    return this
  }

  render(): string {
    const out: string[] = []
    for(const [name, family] of this.families) {
      out.push(`# HELP ${name} ${family.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`)
      out.push(`# TYPE ${name} ${family.type}`)
      out.push(...family.samples)
    }
    return out.join('\n') + '\n'
  }
}
