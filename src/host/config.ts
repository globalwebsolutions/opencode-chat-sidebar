import * as vscode from "vscode";

export interface SidebarConfig {
  executablePath: string;
  serverUrl: string;
  allowRemoteServer: boolean;
  defaultModel: string;
  defaultAgent: string;
  autoStart: boolean;
  showUsage: boolean;
}

export const CONFIG_SECTION = "opencodeSidebar";

export function readConfig(): SidebarConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    executablePath: c.get<string>("executablePath", ""),
    serverUrl: c.get<string>("serverUrl", ""),
    allowRemoteServer: c.get<boolean>("allowRemoteServer", false),
    defaultModel: c.get<string>("defaultModel", ""),
    defaultAgent: c.get<string>("defaultAgent", ""),
    autoStart: c.get<boolean>("autoStart", false),
    showUsage: c.get<boolean>("showUsage", true),
  };
}
