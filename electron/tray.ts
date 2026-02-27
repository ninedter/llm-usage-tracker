import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron";
import { join } from "path";
import { setQuitting } from "./main";

let tray: Tray | null = null;

export function createTray(
  mainWindow: BrowserWindow,
  appName: string
): Tray {
  // Create a 16x16 tray icon (template image for macOS dark/light mode)
  const iconPath = join(__dirname, "..", "public", "icons", "tray-icon.png");
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (process.platform === "darwin") {
      icon.setTemplateImage(true);
    }
  } catch {
    // Fallback: create a simple colored square
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip(appName);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        setQuitting(true);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click tray icon to toggle window
  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
