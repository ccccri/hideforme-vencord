# HideForMe — Vencord userplugin

Hide single messages, or **clear a whole chat only for you** (like "delete for me" / WhatsApp "clear chat"), with a history to bring everything back.

Nothing is sent to Discord. The plugin only changes what *your* client displays; other people see no difference.

## Features
- **Clear chat (only for me)**: button in the chat bar and in the message context menu. Hides everything up to now, including older history you scroll to later. New messages keep appearing.
- **Hide for me**: message hover button and context menu entry for a single message.
- **History**: list of hidden messages and cleared chats, per channel or global, with per-item and "restore all" buttons.
- Banner "Chat cleared (only for you) — Show again" when a cleared chat has nothing visible.
- Date separators and message groups stay tidy when messages in between are hidden.
- Data is stored locally in Vencord's DataStore (keys `HideForMe_v1`, `HideForMe_cleared_v1`) and sanitised on load.

## Install
Vencord does not load third-party plugins from the official build: you need a [custom Vencord build](https://docs.vencord.dev/installing/custom-vencord/).

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
mkdir -p src/userplugins
cp -r /path/to/hideforme-vencord/hideForMe src/userplugins/   # or `unzip hideForMe-1.0.1.zip "hideForMe/*" -d src/userplugins/`
pnpm build
pnpm inject            # desktop Discord; for Vesktop point "Vencord location" to this repo's dist/
```
Then enable **HideForMe** in Settings → Vencord → Plugins and restart/reload Discord.

Requires Node ≥ 22 and pnpm 11.

## Notes
- Tested against Vencord 1.15.17 (for 1.15.13 use release v1.0.0): type-check (`pnpm testTsc`), `eslint` and `pnpm build` pass. It relies on Discord's DOM (`li[id^="chat-messages-"]`) and on `LOAD_MESSAGES_SUCCESS`, so Discord updates can break the visual part.
- Hidden state lives in your Vencord data: it is not synced between devices.

## License
GPL-3.0-or-later, same as Vencord (see `LICENSE`).
