import fs from 'fs/promises'
import path from 'path'
import { statePath } from '../config'
import { genKeyPair, genPresharedKey, addPeer, removePeer } from '../awg/peers'
import { ServerConfig } from '../awg/serverConfig'

export interface ClientRecord {
  id: string
  name: string
  address: string
  publicKey: string
  privateKey: string
  presharedKey: string
  enabled: boolean
  createdAt: string
}

const clientsPath = path.join(statePath, 'clients.json')

export async function getClients(): Promise<ClientRecord[]> {
  return JSON.parse(await fs.readFile(clientsPath, 'utf8'))
}

async function saveClients(clients: ClientRecord[]): Promise<void> {
  await fs.writeFile(clientsPath, JSON.stringify(clients), 'utf8')
}

function nextAddress(clients: ClientRecord[], subnet: string): string {
  const usedLastOctets = clients
    .map(client => Number(client.address.slice(subnet.length)))
    .filter(n => Number.isInteger(n))

  const next = usedLastOctets.length > 0 ? Math.max(...usedLastOctets) + 1 : 1

  return `${subnet}${next}`
}

export async function createClient(name: string, server: ServerConfig): Promise<ClientRecord> {
  const clients = await getClients()

  const { privateKey, publicKey } = await genKeyPair()
  const presharedKey = await genPresharedKey()
  const address = nextAddress(clients, server.subnet)

  await addPeer(publicKey, presharedKey, address)

  const client: ClientRecord = {
    id: name,
    name,
    address,
    publicKey,
    privateKey,
    presharedKey,
    enabled: true,
    createdAt: new Date().toISOString()
  }

  clients.push(client)
  await saveClients(clients)

  return client
}

export async function revokeClient(client: ClientRecord): Promise<void> {
  await removePeer(client.publicKey)

  const clients = await getClients()
  const target = clients.find(c => c.id === client.id)

  if(target) {
    target.enabled = false
  }

  await saveClients(clients)
}
