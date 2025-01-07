import fetch from 'isomorphic-unfetch'

import { wgEasyHost } from '../config'
import { getCookie } from './getCookie'
import { WGClient } from './types'

export async function getClients(): Promise<WGClient[]> {
  const cookie = await getCookie()

  const respClients = await fetch(`http://${wgEasyHost}/api/wireguard/client`, {
    headers: {
      'Cookie': cookie
    },
  })

  const clients = await respClients.json()

  return clients
}
