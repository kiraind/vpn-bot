import type { ProtocolName } from '../config/schema'
import type { ObfuscationParams } from '../types'
import { awg2 } from './awg2'
import { awg3 } from './awg3'

/** Knows one AWG version's obfuscation param set (R-O3). */
export interface ProtocolProfile {
  name: ProtocolName
  /** Fresh random params for one interface; both peers of that interface must use them. */
  generateParams(): ObfuscationParams
  /** Interface-section keys this version understands, in config-file order. */
  paramKeys: string[]
}

const profiles: Record<ProtocolName, ProtocolProfile> = { awg2, awg3 }

export function getProfile(name: ProtocolName): ProtocolProfile {
  const profile = profiles[name]
  if(!profile) throw new Error(`unknown protocol profile: ${name}`)
  return profile
}
