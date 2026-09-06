# vpn-bot

Start:

```
npm ci
npm run build
npm run pm2:start
npm run pm2:save
```

Enable autostart on reboot (one-time, needs sudo):

```
npm run pm2:startup
```

This prints a `sudo env PATH=... pm2 startup ...` command — copy it and run it as shown. After that, `pm2 save` (already run above, and again after any future `pm2:start`/`pm2:delete`) snapshots the current process list so pm2 resurrects it on boot.

Update:

```
npm ci
git pull
npm run build
npm run pm2:reload
npm run pm2:save
```

Etc.

```
npm run pm2:restart
npm run pm2:reload
npm run pm2:stop
npm run pm2:delete
npm run pm2:logs

cat ~/.pm2/logs/vpn-bot-out.log | grep Banned
```