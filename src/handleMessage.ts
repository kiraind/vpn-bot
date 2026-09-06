import fs from 'fs/promises'
import path from 'path'
import TelegramBot from 'node-telegram-bot-api'
import QRCode from 'qrcode'
import { bot } from './bot'
import { getClients, createClient, revokeClient } from './store/clients'
import { getServerConfig } from './awg/serverConfig'
import { buildClientConfig } from './awg/clientConfigText'
import { checkMembership } from './checkMembership'
import { statePath } from './config'

export async function handleMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;

  if(!fromId) {
    return
  }

  if(fromId !== chatId) {
    return
  }

  const [isMember] = await checkMembership(fromId)

  if(!isMember) {
    await bot.sendMessage(fromId, 'Сорри, тебя нет в списках')
    return
  }

  const username = msg.from?.username;

  if(!username) {
    await bot.sendMessage(fromId, 'Пожалуйста, поставь юзернейм в телеграме')
    return
  }


  const text = msg.text;

  if(!text) {
    return
  }

  await bot.sendChatAction(fromId, 'typing')

  // save to users list
  const usersPath = path.join(statePath, 'users.json')
  const users: Record<string, number> = JSON.parse(
    await fs.readFile(usersPath, 'utf8')
  )
  users[username] = fromId;
  await fs.writeFile(usersPath, JSON.stringify(users), 'utf8')

  const devices = await getClients()

  if(text.startsWith('/add')) {
    const id = text.split(' ')[1]

    if(!id || !/^[a-z0-9-]+$/i.test(id)) {
      await bot.sendMessage(fromId, 'Укажите имя устройства из латинских букв, цифр и черточек (-)')
      return
    }

    const fullId = `${username}:${id}`;

    if(devices.find(device => device.name === fullId)) {
      await bot.sendMessage(fromId, 'Устройство с таким именем уже есть')
      return
    }

    const server = await getServerConfig()
    const client = await createClient(fullId, server)

    const configText = buildClientConfig(client, server)
    const configBuffer = Buffer.from(configText, 'utf8')
    const qrBuffer = await QRCode.toBuffer(configText, { type: 'png' })

    await bot.sendMessage(
      fromId,
      'Готово!'
    )

    const qrMessage = await bot.sendPhoto(
      fromId,
      qrBuffer,
      {
        caption: 'Отсканируй этот код в приложении WireGuard —'
      },
      {
        contentType: 'image/png',
      }
    )

    const configMessage = await bot.sendDocument(
      fromId,
      configBuffer,
      {
        caption: '— или выбери в нем этот файл конфигурации.'
      },
      {
        filename: `${id}.wireguard.conf`,
        contentType: 'plain/text'
      }
    )

    const warningMessage = await bot.sendMessage(
      fromId,
      'Эти сообщения удалятся через 5 минут. Не делись ими ни с кем и не используй одинаковые конфиги для разных устройств.'
    )

    setTimeout(() => {
      bot.deleteMessage(fromId, qrMessage.message_id)
      bot.deleteMessage(fromId, configMessage.message_id)
      bot.deleteMessage(fromId, warningMessage.message_id)
    }, 5 * 60 * 1000)
  } else if(text.startsWith('/remove')) {
    const id = text.split(' ')[1]

    const fullId = `${username}:${id}`;

    const userDevices = devices.filter(client => client.name.startsWith(`${username}:`) && client.enabled)

    const device = userDevices.find(device => device.name === fullId);

    if(!device) {
      await bot.sendMessage(fromId, 'Устройства с таким именем нет :(')
      return
    }

    await revokeClient(device)

    await bot.sendMessage(
      fromId,
      'Готово!'
    )
  } else if(text.startsWith('/start') || text.startsWith('/info')) {
    const userDevices = devices.filter(client => client.name.startsWith(`${username}:`) && client.enabled)
    const deviceList = userDevices.map(device => `📲 \`${device.name.split(':')[1]}\``).join('\n')

    await bot.sendMessage(
      fromId,
      (userDevices.length > 0 ? (
        `Твои устройства:\n\n${deviceList}\n`
      ) : (
        `У тебя сейчас нет активных устройств\n`
      )) +
      `\n` +
      `Доступные команды:\n` +
      `\n` +
      `\`/start\` или \`/info\` — увидеть это сообщение\n` +
      `\`/add <device-id>\` — добавить новое устройство\n` +
      `\`/remove <device-id>\` — удалить устройство\n`,
      {parse_mode: 'MarkdownV2'}
    )
  } else {
    await bot.sendMessage(
      fromId,
      `Не понимаю, попробуй /start`
    )
  }
}
