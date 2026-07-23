/**
 * Menu-bar tray. Uses a small embedded 16x16 template PNG (macOS renders
 * template images black/white automatically for light/dark menu bars).
 */

import { Menu, Tray, nativeImage } from "electron";
import type { ConnectorStatus } from "./connectorManager";
import { getSettings, setSetting } from "./settings";

// 16x16 black-on-transparent "G" ring, generated at build time and embedded.
const TRAY_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nGNgGKzgPw5MkWaiDMGnkKAhxNiC1wUk+ZMUA4gOC5oZQLIXCAUi2TFBVlqgemochAAAOYpFu0oQMCEAAAAASUVORK5CYII=";

export type TrayHandlers = {
  onOpen: () => void;
  onRestartConnector: () => void;
  onCheckForUpdates: () => void;
  onQuit: () => void;
};

function connectorLabel(status: ConnectorStatus): string {
  switch (status.state) {
    case "running":
      return status.paired ? "Connector: online" : "Connector: running (unpaired)";
    case "starting":
      return "Connector: starting…";
    case "pairing":
      return "Connector: pairing…";
    case "error":
      return "Connector: restarting…";
    default:
      return "Connector: stopped";
  }
}

export class GroovyTray {
  private tray: Tray;
  private connectorStatus: ConnectorStatus = {
    state: "stopped",
    paired: false,
    pairedUserId: null,
    deviceId: null,
  };

  constructor(private handlers: TrayHandlers) {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Groovy");
    this.tray.on("click", () => this.handlers.onOpen());
    this.rebuildMenu();
  }

  updateConnectorStatus(status: ConnectorStatus) {
    this.connectorStatus = status;
    this.rebuildMenu();
  }

  private rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: "Open Groovy", click: () => this.handlers.onOpen() },
      { type: "separator" },
      { label: connectorLabel(this.connectorStatus), enabled: false },
      { label: "Restart connector", click: () => this.handlers.onRestartConnector() },
      { type: "separator" },
      { label: "Check for updates", click: () => this.handlers.onCheckForUpdates() },
      {
        label: "Keep running in background",
        type: "checkbox",
        checked: getSettings().keepRunningInBackground,
        click: (item) => {
          setSetting("keepRunningInBackground", item.checked);
        },
      },
      { type: "separator" },
      { label: "Quit Groovy", click: () => this.handlers.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy() {
    this.tray.destroy();
  }
}
