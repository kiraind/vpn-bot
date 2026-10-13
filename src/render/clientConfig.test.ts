import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { clientRevision, countryServerName, renderClientConf, renderVpnKey, type ClientRenderInput } from './clientConfig'

const input: ClientRenderInput = {
  config: { id: 'u-1', name: 'phone', address: '10.66.0.2', privateKey: 'cPriv+/=', presharedKey: 'psk+/=' },
  server: {
    publicKey: 'sPub+/=',
    params: { H1: '100-200', Jc: '4', S1: '37', Zz: 'x', Jmin: '10', Jmax: '50', I1: '' },
    endpointHost: '203.0.113.10',
    listenPort: 51820,
  },
  dns: ['1.1.1.1', '8.8.8.8'],
  mtu: 1280,
  serverName: 'My VPN — phone',
}

function decode(key: string): any {
  expect(key.startsWith('vpn://')).toBe(true)
  const body = key.slice('vpn://'.length)
  expect(body).toMatch(/^[A-Za-z0-9_-]+$/)
  const buf = Buffer.from(body, 'base64url')
  const raw = inflateSync(buf.subarray(4))
  expect(buf.readUInt32BE(0)).toBe(raw.length)
  return JSON.parse(raw.toString('utf8'))
}

describe('renderClientConf', () => {
  it('renders the expected text with params in stable order', () => {
    expect(renderClientConf(input)).toBe([
      '[Interface]',
      'Address = 10.66.0.2/32',
      'DNS = 1.1.1.1, 8.8.8.8',
      'PrivateKey = cPriv+/=',
      'MTU = 1280',
      'Jc = 4',
      'Jmin = 10',
      'Jmax = 50',
      'S1 = 37',
      'H1 = 100-200',
      'Zz = x',
      '',
      '[Peer]',
      'PublicKey = sPub+/=',
      'PresharedKey = psk+/=',
      'AllowedIPs = 0.0.0.0/0, ::/0',
      'Endpoint = 203.0.113.10:51820',
      'PersistentKeepalive = 25',
      '',
    ].join('\n'))
  })

  it('does not depend on params insertion order', () => {
    const reordered = { ...input, server: { ...input.server, params: Object.fromEntries(Object.entries(input.server.params).reverse()) } }
    expect(renderClientConf(reordered)).toBe(renderClientConf(input))
  })
})

describe('clientRevision', () => {
  it('is 8 hex chars and stable', () => {
    expect(clientRevision(input)).toMatch(/^[0-9a-f]{8}$/)
    expect(clientRevision({ ...input })).toBe(clientRevision(input))
  })

  it('changes when any rendered field changes', () => {
    const base = clientRevision(input)
    expect(clientRevision({ ...input, mtu: 1300 })).not.toBe(base)
    expect(clientRevision({ ...input, dns: ['1.1.1.1'] })).not.toBe(base)
    expect(clientRevision({ ...input, server: { ...input.server, listenPort: 1 } })).not.toBe(base)
    expect(clientRevision({ ...input, server: { ...input.server, params: { ...input.server.params, Jc: '5' } } })).not.toBe(base)
    expect(clientRevision({ ...input, config: { ...input.config, presharedKey: 'other' } })).not.toBe(base)
  })

  it('ignores fields that do not affect the text', () => {
    expect(clientRevision({ ...input, config: { ...input.config, name: 'laptop', id: 'u-2' } })).toBe(clientRevision(input))
  })
})

describe('renderVpnKey', () => {
  it('round-trips to the AmneziaVPN native-AWG JSON shape', () => {
    const json = decode(renderVpnKey(input))
    expect(json.defaultContainer).toBe('amnezia-awg')
    expect(json.description).toBe('My VPN — phone')
    expect(json.hostName).toBe('203.0.113.10')
    expect(json.dns1).toBe('1.1.1.1')
    expect(json.dns2).toBe('8.8.8.8')
    expect(json.containers).toHaveLength(1)
    const c = json.containers[0]
    expect(c.container).toBe('amnezia-awg')
    expect(c.awg.port).toBe('51820')
    expect(c.awg.transport_proto).toBe('udp')
    expect(c.awg.isThirdPartyConfig).toBe(true)
    expect(c.awg.Jc).toBe('4')
    expect(c.awg.H1).toBe('100-200')
    expect(c.awg.I1).toBeUndefined()

    const last = JSON.parse(c.awg.last_config)
    expect(last.config).toBe(renderClientConf(input))
    expect(last.hostName).toBe('203.0.113.10')
    expect(last.port).toBe(51820)
    expect(last.client_ip).toBe('10.66.0.2/32')
    expect(last.client_priv_key).toBe('cPriv+/=')
    expect(last.psk_key).toBe('psk+/=')
    expect(last.server_pub_key).toBe('sPub+/=')
    expect(last.allowed_ips).toEqual(['0.0.0.0/0', '::/0'])
    expect(last.persistent_keep_alive).toBe('25')
    expect(last.mtu).toBe('1280')
    expect(last.Jmax).toBe('50')
  })

  it('duplicates a single DNS into dns2', () => {
    const json = decode(renderVpnKey({ ...input, dns: ['9.9.9.9'] }))
    expect(json.dns1).toBe('9.9.9.9')
    expect(json.dns2).toBe('9.9.9.9')
  })
})

describe('single DNS', () => {
  it('repeats a lone DNS server so the AmneziaVPN importer accepts the line', () => {
    expect(renderClientConf({ ...input, dns: ['10.0.0.53'] })).toContain('DNS = 10.0.0.53, 10.0.0.53\n')
  })
})

describe('server name', () => {
  it('is a flag plus the Russian country name', () => {
    expect(countryServerName('NL')).toBe('🇳🇱 Нидерланды')
    expect(countryServerName('de')).toBe('🇩🇪 Германия')
  })

  it('moves the revision without touching the conf text', () => {
    const renamed = { ...input, serverName: '🇳🇱 Нидерланды' }
    expect(renderClientConf(renamed)).toBe(renderClientConf(input))
    expect(clientRevision(renamed)).not.toBe(clientRevision(input))
    expect(decode(renderVpnKey(renamed)).description).toBe('🇳🇱 Нидерланды')
  })
})
