# vpn-coordinator

Координатор VPN на AmneziaWG по схеме LOCAL → REMOTE: клиенты подключаются к серверу LOCAL, трафик в «свою» страну выходит с LOCAL, остальной — с REMOTE через межсерверный туннель. Доступ есть только у участников заданного Telegram-чата.

Координатор хранит всё состояние (декларативный `config.yaml` + SQLite), сам настраивает чистые Ubuntu 24.04 по SSH и поддерживает их в актуальном состоянии. Замена сервера — это замена его адреса и пароля в конфиге. Пользователи получают конфиги через Telegram-бота или через [форк AmneziaVPN](https://github.com/kiraind/amnezia-client) (вход по коду из бота).

- Спецификация: [docs/spec/coordinator-spec.md](docs/spec/coordinator-spec.md)
- Инструкция по эксплуатации (деплой, аварии, команды бота): [docs/spec/runbook.md](docs/spec/runbook.md)
- Пример конфига: [examples/config.example.yaml](examples/config.example.yaml)

## Быстрый старт

Полная процедура (DNS, Caddy, ключ бэкапов, серверы) — в runbook, раздел 1.

```
git clone https://github.com/kiraind/vpn-bot /opt/vpn-coordinator && cd /opt/vpn-coordinator
npm ci && npm run build
mkdir -p /etc/vpn-coordinator
cp examples/config.example.yaml /etc/vpn-coordinator/config.yaml && chmod 600 /etc/vpn-coordinator/config.yaml
# заполнить config.yaml; секреты вида ${VAR} можно положить в /opt/vpn-coordinator/.env
npm run check-config
npm run pm2:start && npm run pm2:save
npm run pm2:startup   # один раз, для автозапуска
```

Обновление: `npm run update` (git pull, сборка, `pm2 reload`).

## Разработка

```
npm run dev        # запуск с перезагрузкой
npm test           # vitest
npm run typecheck
```

Каталог `legacy/` — старый бот для одного сервера, оставлен только для справки.
