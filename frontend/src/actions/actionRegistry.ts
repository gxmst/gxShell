/**
 * The shared action vocabulary used by keyboard shortcuts, the command
 * palette, menus, and (eventually) accessibility help.  Keeping the metadata
 * next to the action is important: a shortcut should not quietly drift away
 * from the operation it invokes.
 */

export type ActionScope = "global" | "workspace" | "terminal" | "form" | "modal";

export type ActionShortcut = {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** `Mod` means Ctrl on Windows/Linux and Meta on macOS. */
  mod?: boolean;
};

export type ActionContext = {
  event: KeyboardEvent;
  target: Element | null;
  isTerminalInput: boolean;
  isEditable: boolean;
  isOverlay: boolean;
  activeTab: string;
  activeIsMarkdown: boolean;
};

export type ActionDefinition<Context = ActionContext> = {
  id: string;
  label: string;
  category: string;
  scope: ActionScope;
  /** Human-readable defaults used by the help/palette UI. */
  defaultShortcuts: readonly string[];
  /** Optional structured shortcuts used for dispatch. */
  shortcuts?: readonly ActionShortcut[];
  /** Dynamic actions (for example Alt+1…Alt+9) can supply a matcher. */
  matches?: (event: KeyboardEvent, context: Context) => boolean;
  availability?: (context: Context) => boolean;
  /** Actions that are safe from a focused form or overlay opt in explicitly. */
  allowInEditable?: boolean;
  allowInOverlay?: boolean;
  run: (context: Context) => void;
};

export type ActionRegistryListener<Context> = (
  action: ActionDefinition<Context>,
  context: Context,
) => void;

const normalizeKey = (key: string) => key.length === 1 ? key.toLowerCase() : key;

export function shortcutToString(shortcut: ActionShortcut): string {
  const modifiers: string[] = [];
  if (shortcut.mod) modifiers.push("Mod");
  else {
    if (shortcut.ctrl) modifiers.push("Ctrl");
    if (shortcut.meta) modifiers.push("Meta");
  }
  if (shortcut.alt) modifiers.push("Alt");
  if (shortcut.shift) modifiers.push("Shift");
  return [...modifiers, shortcut.key === " " ? "Space" : shortcut.key].join("+");
}

export function shortcutMatches(event: KeyboardEvent, shortcut: ActionShortcut): boolean {
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) return false;
  const modifier = shortcut.mod
    ? (event.ctrlKey || event.metaKey)
    : ((shortcut.ctrl ?? false) === event.ctrlKey && (shortcut.meta ?? false) === event.metaKey);
  return modifier
    && (shortcut.alt ?? false) === event.altKey
    && (shortcut.shift ?? false) === event.shiftKey;
}

/**
 * A small ordered registry. Registration order is the conflict resolution
 * order, so callers can deliberately put a more specific action first.
 */
export class ActionRegistry<Context = ActionContext> {
  private readonly actions = new Map<string, ActionDefinition<Context>>();
  private readonly listeners = new Set<ActionRegistryListener<Context>>();

  register(action: ActionDefinition<Context>): this {
    if (this.actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action);
    return this;
  }

  registerMany(actions: readonly ActionDefinition<Context>[]): this {
    actions.forEach((action) => this.register(action));
    return this;
  }

  replace(action: ActionDefinition<Context>): this {
    this.actions.set(action.id, action);
    return this;
  }

  get(id: string): ActionDefinition<Context> | undefined {
    return this.actions.get(id);
  }

  list(): ActionDefinition<Context>[] {
    return [...this.actions.values()];
  }

  onDispatch(listener: ActionRegistryListener<Context>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  findForEvent(event: KeyboardEvent, context: Context): ActionDefinition<Context> | undefined {
    return this.list().find((action) => {
      if (!action.allowInOverlay && (context as ActionContext).isOverlay) return false;
      if (!action.allowInEditable && (context as ActionContext).isEditable) return false;
      if (action.availability && !action.availability(context)) return false;
      if (action.matches) return action.matches(event, context);
      return action.shortcuts?.some((shortcut) => shortcutMatches(event, shortcut)) ?? false;
    });
  }

  dispatch(event: KeyboardEvent, context: Context): ActionDefinition<Context> | undefined {
    if (event.defaultPrevented) return undefined;
    const action = this.findForEvent(event, context);
    if (!action) return undefined;
    event.preventDefault();
    action.run(context);
    this.listeners.forEach((listener) => listener(action, context));
    return action;
  }

  /** Return shortcut collisions, grouped by the normalized shortcut string. */
  conflicts(): Map<string, ActionDefinition<Context>[]> {
    const groups = new Map<string, ActionDefinition<Context>[]>();
    for (const action of this.actions.values()) {
      for (const shortcut of action.shortcuts || []) {
        const key = shortcutToString(shortcut).toLowerCase();
        const list = groups.get(key) || [];
        list.push(action);
        groups.set(key, list);
      }
    }
    return new Map([...groups].filter(([, actions]) => actions.length > 1));
  }
}

export type HotkeyCallbacks = {
  onGlobalSearch: () => void;
  onTerminalSearch: () => void;
  onCloseTab: (id: string) => void;
  onNextTab: () => void;
  onPrevTab: () => void;
  onSelectTab: (index: number) => void;
  labels?: Partial<{
    nextTab: string;
    selectTab: string;
    workspaceSearch: string;
    terminalSearch: string;
    closeTab: string;
  }>;
};

/** Build the default workspace actions without coupling the registry to React. */
export function createDefaultActionRegistry(
  callbacks: HotkeyCallbacks,
  getState: () => Pick<ActionContext, "activeTab" | "activeIsMarkdown"> = () => ({ activeTab: "", activeIsMarkdown: false }),
): ActionRegistry<ActionContext> {
  const registry = new ActionRegistry<ActionContext>();
  registry.registerMany([
    {
      id: "workspace.next-tab",
      label: callbacks.labels?.nextTab || "Next tab",
      category: "Tabs",
      scope: "global",
      defaultShortcuts: ["Ctrl+Tab"],
      shortcuts: [{ key: "Tab", ctrl: true }, { key: "Tab", ctrl: true, shift: true }],
      allowInEditable: true,
      availability: () => true,
      run: (context) => context.event.shiftKey ? callbacks.onPrevTab() : callbacks.onNextTab(),
    },
    {
      id: "workspace.select-tab",
      label: callbacks.labels?.selectTab || "Select tab by number",
      category: "Tabs",
      scope: "global",
      defaultShortcuts: ["Alt+1-9"],
      matches: (event) => event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key),
      allowInEditable: true,
      run: (context) => callbacks.onSelectTab(Number(context.event.key) - 1),
    },
    {
      id: "workspace.search",
      label: callbacks.labels?.workspaceSearch || "Search workspace",
      category: "Workspace",
      scope: "global",
      defaultShortcuts: ["Mod+K"],
      shortcuts: [{ key: "k", mod: true }],
      run: () => callbacks.onGlobalSearch(),
    },
    {
      id: "terminal.search",
      label: callbacks.labels?.terminalSearch || "Find in terminal",
      category: "Terminal",
      scope: "terminal",
      defaultShortcuts: ["Mod+F"],
      availability: (context) => !context.activeIsMarkdown && !!context.activeTab,
      matches: (event, context) => !!context.target?.closest(".xterm, .terminal-host, .floating-terminal")
        && shortcutMatches(event, { key: "f", mod: true }),
      run: () => callbacks.onTerminalSearch(),
    },
    {
      id: "workspace.close-tab",
      label: callbacks.labels?.closeTab || "Close active tab",
      category: "Tabs",
      scope: "global",
      defaultShortcuts: ["Mod+Shift+W"],
      shortcuts: [{ key: "w", mod: true, shift: true }],
      availability: (context) => !!context.activeTab,
      run: (context) => callbacks.onCloseTab(context.activeTab || getState().activeTab),
    },
  ]);
  return registry;
}
