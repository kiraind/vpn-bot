import fetch from 'isomorphic-unfetch'

import { wgEasyHost, wgEasyPassword } from '../config'

export async function getCookie(): Promise<string> {
  const respAuth = await fetch(`http://${wgEasyHost}/api/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      password: wgEasyPassword
    })
  })

  const cookie = respAuth.headers.getSetCookie()[0].split(';')[0]

  return cookie
}

