/**
 * The app registry. Every app is a lazy module in its own folder under
 * client/src/apps/<id>/ with a default export that takes AppProps. The window
 * manager, dock, menu bar and launcher all read apps from here.
 */
import { createElement, lazy, useState, type ComponentType } from 'react';
import { APP_COLORS } from '../design/color';
import { agentMenus } from './agent/menus';
import { agentsMenus } from './agents/menus';
import { chatMenus } from './chat/menus';
import { filesMenus } from './files/commands';
import { activityMenus } from './activity/menus';
import { editorMenus } from './editor/menus';
import { systemMenus } from './system/menus';
import { terminalMenus } from './terminal/menus';

export type AppId = 'files' | 'terminal' | 'editor' | 'chat' | 'agents' | 'activity' | 'system' | 'agent';

export interface AppProps {
  windowId: string;
  /** Whatever the window was opened with, for example { path } or { agentId }. */
  params: Record<string, unknown>;
  /** Sets the window's title bar text. */
  setTitle(title: string): void;
  /** True while this is the front window. */
  focused: boolean;
}

export interface MenuItem {
  label: string;
  /** Shown at the right of the item, for example "Ctrl+S". */
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  /** Renders a rule instead of an item; label is ignored. */
  separator?: boolean;
  checked?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export interface AppDefinition {
  id: AppId;
  name: string;
  /** One line, shown in the launcher and in tooltips. */
  description: string;
  /** The app's own colour, as a CSS colour. */
  color: string;
  component: ComponentType<AppProps>;
  /** Fetches the app's code ahead of its first window. */
  preload(): Promise<unknown>;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** A singleton has one window; opening it again focuses that window. */
  singleton: boolean;
  inDock: boolean;
  /** Menus shown in the menu bar while a window of this app is active. */
  menus?: (windowId: string) => Menu[];
}

/**
 * An app's code, fetched once. A window opened after the code has arrived draws its app in the
 * same frame; one opened before waits for it behind the window's skeleton.
 */
function appCode(load: () => Promise<{ default: ComponentType<AppProps> }>): Pick<AppDefinition, 'component' | 'preload'> {
  let loaded: ComponentType<AppProps> | null = null;
  let fetching: Promise<{ default: ComponentType<AppProps> }> | null = null;
  const preload = () =>
    (fetching ??= load().then(
      (module) => {
        loaded = module.default;
        return module;
      },
      (error: unknown) => {
        // The next window asks again.
        fetching = null;
        throw error;
      },
    ));
  const Waiting = lazy(preload);
  function component(props: AppProps) {
    // Chosen once per window, so the app is never mounted a second time when its code arrives.
    const [Ready] = useState(() => loaded);
    return createElement(Ready ?? Waiting, props);
  }
  return { component, preload };
}

export const APPS: Record<AppId, AppDefinition> = {
  files: {
    id: 'files',
    name: 'Files',
    description: 'Browse the home folder and watch agents change it.',
    color: APP_COLORS.files,
    ...appCode(() => import('./files/index')),
    defaultSize: { w: 980, h: 620 },
    minSize: { w: 560, h: 360 },
    singleton: false,
    inDock: true,
    menus: filesMenus,
  },
  terminal: {
    id: 'terminal',
    name: 'Terminal',
    description: 'A real shell on this machine.',
    color: APP_COLORS.terminal,
    ...appCode(() => import('./terminal/index')),
    defaultSize: { w: 820, h: 520 },
    minSize: { w: 420, h: 260 },
    singleton: false,
    inDock: true,
    menus: terminalMenus,
  },
  editor: {
    id: 'editor',
    name: 'Editor',
    description: 'Edit a file and save it back to disk.',
    color: APP_COLORS.editor,
    ...appCode(() => import('./editor/index')),
    defaultSize: { w: 900, h: 640 },
    minSize: { w: 480, h: 320 },
    singleton: false,
    inDock: true,
    menus: editorMenus,
  },
  chat: {
    id: 'chat',
    name: 'Chat',
    description: 'Give an agent a job in plain words.',
    color: APP_COLORS.chat,
    ...appCode(() => import('./chat/index')),
    defaultSize: { w: 920, h: 700 },
    minSize: { w: 440, h: 400 },
    singleton: true,
    inDock: true,
    menus: chatMenus,
  },
  agents: {
    id: 'agents',
    name: 'Agents',
    description: 'Every agent job, its workspace and the files it touched.',
    color: APP_COLORS.agents,
    ...appCode(() => import('./agents/index')),
    defaultSize: { w: 960, h: 640 },
    minSize: { w: 520, h: 360 },
    singleton: true,
    inDock: true,
    menus: agentsMenus,
  },
  activity: {
    id: 'activity',
    name: 'Activity',
    description: 'Every file change, who made it, and the diff.',
    color: APP_COLORS.activity,
    ...appCode(() => import('./activity/index')),
    defaultSize: { w: 1040, h: 660 },
    minSize: { w: 560, h: 360 },
    singleton: true,
    inDock: true,
    menus: activityMenus,
  },
  system: {
    id: 'system',
    name: 'System',
    description: 'This machine, and how fast it gives an agent its own copy.',
    color: APP_COLORS.system,
    ...appCode(() => import('./system/index')),
    defaultSize: { w: 900, h: 800 },
    minSize: { w: 520, h: 420 },
    singleton: true,
    inDock: true,
    menus: systemMenus,
  },
  agent: {
    id: 'agent',
    name: 'Agent',
    description: 'One agent job, live.',
    color: APP_COLORS.agent,
    ...appCode(() => import('./agent/index')),
    defaultSize: { w: 760, h: 600 },
    minSize: { w: 420, h: 320 },
    singleton: false,
    inDock: false,
    menus: agentMenus,
  },
};

export const APP_IDS = Object.keys(APPS) as AppId[];

/** The apps that always sit in the dock, in dock order. */
export const DOCK_APPS: AppDefinition[] = APP_IDS.map((id) => APPS[id]).filter((app) => app.inDock);

export function isAppId(value: string): value is AppId {
  return value in APPS;
}

export function getApp(id: AppId): AppDefinition {
  return APPS[id];
}

/**
 * Fetches every app's code ahead of its first window, so a window opens with its app
 * already drawn instead of an empty body. A failed fetch is left for the window to report.
 */
export function preloadApps(): void {
  for (const id of APP_IDS) APPS[id].preload().catch(() => undefined);
}
