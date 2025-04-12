# vpn-bot

Start:

```
npm ci
npm run build
pm2 start dist/index.js --name vpn-bot
pm2 save
```

Update:

```
npm ci
git pull
npm run build
pm2 reload vpn-bot
pm2 save
```

Etc.

```
pm2 restart vpn-bot
pm2 reload vpn-bot
pm2 stop vpn-bot
pm2 delete vpn-bot
```
