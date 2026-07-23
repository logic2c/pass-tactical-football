import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const appRoot = path.join(__dirname, "..", "..");
const gamePage = path.join(appRoot, "desktop-dist", "index.html");
const tutorialPage = path.join(appRoot, "desktop-dist", "tutorial.html");

function protectWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
}

function createGameWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#ece9df",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  protectWindow(window);
  window.loadFile(gamePage);
  return window;
}

function openTutorial() {
  const window = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 620,
    minHeight: 520,
    title: "PASS 游戏教程",
    backgroundColor: "#ece9df",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  protectWindow(window);
  window.loadFile(tutorialPage);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "游戏",
        submenu: [
          { label: "重新开始", accelerator: "Ctrl+R", role: "reload" },
          { type: "separator" },
          { label: "退出", role: "quit" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          { label: "游戏教程", accelerator: "F1", click: openTutorial },
          {
            label: "项目主页",
            click: () => shell.openExternal("https://github.com/logic2c/pass-tactical-football"),
          },
        ],
      },
    ]),
  );

  createGameWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createGameWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
