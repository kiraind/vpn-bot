// Shared fixtures for the node renderer tests (kept out of *.test.ts so importing doesn't re-run tests).
import type { LocalRenderInput, RemoteRenderInput } from './input'

export const remoteParams = { H2: '22', S1: '11', Jc: '4', H1: '21', Jmax: '50', Jmin: '10', S2: '12', Zz: 'x', I1: '<b 0x01>' }

export const localInput: LocalRenderInput = {
  node: 'main/local',
  identity: {
    role: 'local',
    awgc: { privateKey: 'cPriv', publicKey: 'cPub', listenPort: 51820, protocol: 'awg2', params: { S1: '5', Jc: '3' } },
    awgt: { privateKey: 'tPriv', publicKey: 'tPub' },
  },
  remote: { privateKey: 'rPriv', publicKey: 'rPub', listenPort: 40000, protocol: 'awg2', params: remoteParams, presharedKey: 'tPsk' },
  addresses: { client: '1.1.1.10', outer: '1.1.1.11', tunnel: '1.1.1.12' },
  sshPort: 22,
  remoteTunnelAddress: '2.2.2.20',
  clientSubnet: '10.66.0.0/16',
  tunnelSubnet: '10.255.0.0/30',
  tunnelMtu: 1380,
  peers: [
    { publicKey: 'p10', presharedKey: 'k10', address: '10.66.0.10' },
    { publicKey: 'p2', presharedKey: 'k2', address: '10.66.0.2' },
    { publicKey: 'p256', presharedKey: 'k256', address: '10.66.1.0' },
  ],
  geoHome: ['5.0.0.0/8'],
  forceRemote: [],
}

export const remoteInput: RemoteRenderInput = {
  node: 'main/remote',
  identity: { role: 'remote', awgt: localInput.remote },
  localAwgtPublicKey: 'tPub',
  addresses: { outer: '2.2.2.21', tunnel: '2.2.2.20' },
  sshPort: 22,
  localTunnelAddress: '1.1.1.12',
  tunnelSubnet: '10.255.0.0/30',
  tunnelMtu: 1380,
}
