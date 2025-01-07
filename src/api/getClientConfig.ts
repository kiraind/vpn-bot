import fetch from 'isomorphic-unfetch'

import { wgEasyHost } from '../config'
import { getCookie } from './getCookie'

export async function getClientConfig(clientId: string): Promise<Buffer> {
  const cookie = await getCookie()

  const resp = await fetch(`http://${wgEasyHost}/api/wireguard/client/${clientId}/configuration`, {
    headers: {
      'Cookie': cookie
    },
  })

  return Buffer.from(await resp.arrayBuffer())
}
