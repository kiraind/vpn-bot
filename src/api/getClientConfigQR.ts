import fetch from 'isomorphic-unfetch'
import svg2img from 'svg2img'

import { wgEasyHost } from '../config'
import { getCookie } from './getCookie'

export async function getClientConfigQR(clientId: string): Promise<Buffer> {
  const cookie = await getCookie()

  const resp = await fetch(`http://${wgEasyHost}/api/wireguard/client/${clientId}/qrcode.svg`, {
    headers: {
      'Cookie': cookie
    },
  })
  

  const svg = await resp.text()

  return await new Promise((res) => svg2img(svg, (_err, buffer) => res(buffer)))
}
