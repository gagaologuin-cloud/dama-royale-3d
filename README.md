# DAMA ROYALE 3D V36 (package com.damaroyale3d.app)
Works WITHOUT Firebase (Demo mode). Firebase is an optional upgrade for real online play.

## Deploy
1. `cd functions && npm install && cd ..`
2. `firebase deploy` (hosting + database rules + functions; Blaze plan needed for functions)
3. Replace your old database rules with `database.rules.json` (the older rules let any logged-in user edit any room).
4. In Firebase console enable Authentication > Anonymous.

## Android (TWA)
See twa/twa-manifest.json, then `bubblewrap init` / `bubblewrap build`, put the Play App Signing SHA-256 in web/.well-known/assetlinks.json.
In-app product IDs: coins_bronze, coins_starter, coins_gold, coins_plat, coins_silver, coins_vip, vip_life, item_<id>; subscriptions sub_pro_month, sub_pro_year. Set PKG in functions/index.js (already com.damaroyale3d.app).

Coins: earned only by Win +40, Ads +50, Daily +20, Comment +5 (6/day). Spent only on in-game items and match entry. No cash value, no cash payout.
