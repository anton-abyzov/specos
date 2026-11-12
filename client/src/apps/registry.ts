/**
 * The app registry. Every app is a lazy module in its own folder under
 * client/src/apps/<id>/ with a default export that takes AppProps. The window
 * manager, dock, menu bar and launcher all read apps from here.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { APP_COLORS } from '../design/color';
import { activityMenus } from './activity/menus';
import { agentMenus } from './agent/menus';
import { agentsMenus } from './agents/menus';
import { chatMenus } from './chat/menus';
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
  component: LazyExoticComponent<ComponentType<AppProps>>;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** A singleton has one window; opening it again focuses that window. */
  singleton: boolean;
  inDock: boolean;
  /** Menus shown in the menu bar while a window of this app is active. */
  menus?: (windowId: string) => Menu[];
}

export const APPS: Record<AppId, AppDefinition> = {
  files: {
    id: 'files',
    name: 'Files',
    description: 'Browse the home folder and watch agents change it.',
    color: APP_COLORS.files,
    component: lazy(() => import('./files/index')),
    defaultSize: { w: 980, h: 620 },
    minSize: { w: 560, h: 360 },
    singleton: false,
    inDock: true,
  },
  terminal: {
    id: 'terminal',
    name: 'Terminal',
    description: 'A real shell on this machine.',
    color: APP_COLORS.terminal,
    component: lazy(() => import('./terminal/index')),
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
    component: lazy(() => import('./editor/index')),
    defaultSize: { w: 900, h: 640 },
    minSize: { w: 480, h: 320 },
    singleton: false,
    inDock: true,
  },
  chat: {
    id: 'chat',
    name: 'Chat',
    description: 'Give an agent a job in plain words.',
    color: APP_COLORS.chat,
    component: lazy(() => import('./chat/index')),
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
    component: lazy(() => import('./agents/index')),
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
    component: lazy(() => import('./activity/index')),
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
    component: lazy(() => import('./system/index')),
    defaultSize: { w: 760, h: 620 },
    minSize: { w: 520, h: 420 },
    singleton: true,
    inDock: true,
  },
  agent: {
    id: 'agent',
    name: 'Agent',
    description: 'One agent job, live.',
    color: APP_COLORS.agent,
    component: lazy(() => import('./agent/index')),
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
