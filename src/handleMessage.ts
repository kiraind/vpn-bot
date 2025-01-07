import TelegramBot from 'node-telegram-bot-api'
import prettyBytes from 'pretty-bytes-es5'
import { bot } from './bot'
import { getClients } from './api/getClients'
import { getClientConfigQR } from './api/getClientConfigQR'
import { getClientConfig } from './api/getClientConfig'
import { createClient } from './api/createClient'
import { disableClient } from './api/disableClient'
import { checkMembership } from './checkMembership'

export async function handleMessage(msg: TelegramBot.Message) {
  const fromId = msg.from?.id;

  if(!fromId) {
    return
  }
  
  const isMember = await checkMembership(fromId)

  if(isMember) {
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

    await bot.sendChatAction(fromId, 'typing')

    await createClient(fullId)

    const newDevices = await getClients()

    const device = newDevices.find(device => device.name === fullId)

    if(!device) {
      await bot.sendMessage(fromId, 'Ой, ошибка, напиши @kiraind')
      return
    }

    const qrBuffer = await getClientConfigQR(device.id)
    const configBuffer = await getClientConfig(device.id)

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
      'Эти сообщения удалятся через 5 минут. Не делись или ни с кем и не используй одинаковые конфиги для разных устройств.'
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

    await disableClient(device.id)

    await bot.sendMessage(
      fromId,
      'Готово!'
    )
  } else if(text.startsWith('/start') || text.startsWith('/info')) {
    const userDevices = devices.filter(client => client.name.startsWith(`${username}:`) && client.enabled)
    const deviceList = userDevices.map(device => `📲 \`${device.name.split(':')[1]}\`, ${prettyBytes(device.transferRx + device.transferTx).replace('.', '\\.')} трафика`).join('\n')
    
    const allUserDevices = devices.filter(client => client.name.startsWith(`${username}:`))
    const dataUsage = allUserDevices.reduce((sum, device) => sum + device.transferRx + device.transferTx, 0)

    await bot.sendMessage(
      fromId,
      (userDevices.length > 0 ? (
        `Твои устройства:\n\n${deviceList}\n`
      ) : (
        `У тебя сейчас нет активных устройств\n`
      )) +
      `\n` +
      `Всего использовано ${prettyBytes(dataUsage).replace('.', '\\.')} трафика\n` +
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
