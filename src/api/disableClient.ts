import fetch from 'isomorphic-unfetch'

import { wgEasyHost } from '../config'
import { getCookie } from './getCookie'

export async function disableClient(clientId: string): Promise<void> {
  const cookie = await getCookie()

  const resp = await fetch(`http://${wgEasyHost}/api/wireguard/client/${clientId}/disable`, {
    method: 'POST',
    headers: {
      'Cookie': cookie
    }
  })

  const res = await resp.json()

  if(res.success) {
    return
  }

  console.error(res)

  throw new Error('Couldn\'t disable client')
}
