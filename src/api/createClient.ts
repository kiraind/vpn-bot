import fetch from 'isomorphic-unfetch'

import { wgEasyHost } from '../config'
import { getCookie } from './getCookie'

export async function createClient(name: string): Promise<void> {
  const cookie = await getCookie()

  const resp = await fetch(`http://${wgEasyHost}/api/wireguard/client`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({name})
  })

  const res = await resp.json()

  if(res.success) {
    return
  }

  console.error(res)

  throw new Error('Couldn\'t create client')
}
