# DevDock Desktop

A native desktop app to monitor, manage, and control all dev processes listening on TCP ports. Built with Electron, wrapping the [DevDock web app](https://github.com/Osama-Yusuf/devdock-webapp).

## Features

Everything from the web app, plus:

- **System tray** — Lives in your menu bar with active port count
- **Launch at startup** — Toggle from tray menu
- **Hide to tray** — Close the window without quitting
- **Native window** — Hidden title bar with traffic light controls (macOS)
- **No browser needed** — Runs standalone

## Quick Start

```bash
git clone https://github.com/Osama-Yusuf/devdock-desktop.git
cd devdock-desktop
npm install
npm start
```

## Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

Built apps go to the `dist/` folder.

## Tech Stack

- **Electron** — Desktop shell
- **Express + WebSocket** — Backend server (runs inside the app)
- **Vanilla HTML/CSS/JS** — Frontend (no frameworks)

## Requirements

- Node.js >= 18
- macOS, Windows, or Linux
