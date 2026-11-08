// Type declarations for the UBOVM extension API (apiVersion 2).
//
// Third-party VS Code extensions obtain this object with:
//   const api = vscode.extensions.getExtension('ubovm.ubovm-core')?.exports?.ubovm;
// or, for compatibility, exports.ubovmApi.
import type * as vscode from 'vscode';

export type UbovmSlot =
  | 'topbar.actions'
  | 'composer.toolbar'
  | 'welcome.shortcuts'
  | 'status.item';

export interface UbovmSlotContribution {
  id: string;
  label: string;
  title?: string;
  type?: 'button' | 'text' | 'badge' | 'link';
  url?: string;
  order?: number;
  onSelect?: (context: { pluginId: string; slot: UbovmSlot; id: string }) => unknown;
}

export interface UbovmAgentTool {
  name: string;
  label: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (toolCallId: string, input: Record<string, unknown>, token?: unknown) => unknown | Promise<unknown>;
}

export interface UbovmSettingsField {
  key: string;
  type: 'text' | 'boolean' | 'number' | 'select';
  label: string;
  default?: unknown;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface UbovmSettingsSection {
  id: string;
  title: string;
  description?: string;
  fields: UbovmSettingsField[];
}

export interface UbovmMcpServer {
  name: string;
  transport?: 'stdio' | 'streamable_http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  tools?: string[];
  toolNamePrefix?: string;
  enabled?: boolean;
  required?: boolean;
}

export interface UbovmPluginStorage {
  get<T = unknown>(key: string, fallback?: T): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

export interface UbovmPluginLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface UbovmPluginApi {
  readonly apiVersion: 2;
  readonly version: 2;
  readonly slots: Record<UbovmSlot, string>;
  registerSlot(pluginId: string, slot: UbovmSlot, contribution: UbovmSlotContribution): vscode.Disposable;
  registerAgentTool(pluginId: string, tool: UbovmAgentTool): vscode.Disposable;
  registerSkillDirectory(pluginId: string, absoluteDirectory: string): vscode.Disposable;
  registerSettingsSection(pluginId: string, section: UbovmSettingsSection): vscode.Disposable;
  registerMcpServer(pluginId: string, server: UbovmMcpServer): vscode.Disposable;
  onAgentEvent(pluginId: string, listener: (event: { type: string; [key: string]: unknown }) => void): vscode.Disposable;
  getSettings(pluginId: string, sectionId: string): Record<string, unknown>;
  setSetting(pluginId: string, sectionId: string, key: string, value: unknown): Promise<void>;
  onSettingsChanged(pluginId: string, listener: (event: { pluginId: string; sectionId: string; key: string; value: unknown; values: Record<string, unknown> }) => void): vscode.Disposable;
  storage(pluginId: string): UbovmPluginStorage;
  logger(pluginId: string): UbovmPluginLogger;
  workspaceFolders(): string[];
  getInfo(): {
    apiVersion: 2;
    ideVersion: string;
    appName: string;
    platform: string;
    workspaceFolders: string[];
  };
  openExternal(pluginId: string, url: string): Promise<boolean>;
}
