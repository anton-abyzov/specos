/**
 * The row of menus at the left of the menu bar. One menu is open at a time;
 * while one is open, hovering another title switches to it. Focus stays on the
 * title and the highlighted item is tracked here, so arrows, Enter and Escape
 * work the same whether the menu was opened by mouse or keyboard.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Menu, MenuItem } from '../../apps/registry';
import { Glyph } from '../../design/icons';
import { spring } from '../../design/motion';

export interface StripMenu extends Menu {
  id: string;
  /** Drawn instead of the label (the SpecOS mark); the label still names the menu. */
  content?: ReactNode;
}

interface MenuStripProps {
  /** The SpecOS menu, always first. */
  lead: StripMenu;
  /** The active app's name, shown between the SpecOS menu and the app's menus. */
  title: string;
  menus: StripMenu[];
}

const selectable = (item: MenuItem | undefined): boolean => !!item && !item.separator && !item.disabled;

/** The next selectable index from `from` in `direction`, wrapping; -1 when nothing is selectable. */
function step(items: MenuItem[], from: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (((from + direction * offset) % items.length) + items.length) % items.length;
    if (selectable(items[index])) return index;
  }
  return -1;
}

export function MenuStrip({ lead, title, menus }: MenuStripProps) {
  const all = [lead, ...menus];
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  const openMenu = all[open ?? -1];
  const close = useCallback(() => {
    setOpen(null);
    setActive(-1);
  }, []);

  // The app in front changed and took the open menu with it.
  useEffect(() => {
    if (open !== null && open >= all.length) close();
  }, [open, all.length, close]);

  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onBlur = () => close();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  const show = (index: number, activeIndex = -1) => {
    setOpen(index);
    setActive(activeIndex);
  };

  const run = (item: MenuItem) => {
    if (!selectable(item)) return;
    close();
    item.action?.();
  };

  const focusTrigger = (index: number) => triggers.current[index]?.focus();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = triggers.current.findIndex((trigger) => trigger === document.activeElement);
    const current = open ?? focused;
    if (current < 0) return;
    const sideways = (direction: 1 | -1) => {
      const next = (current + direction + all.length) % all.length;
      focusTrigger(next);
      if (open !== null) show(next, step(all[next]!.items, -1, 1));
    };

    switch (event.key) {
      case 'ArrowRight':
        sideways(1);
        break;
      case 'ArrowLeft':
        sideways(-1);
        break;
      case 'ArrowDown':
        if (open === null) show(current, step(all[current]!.items, -1, 1));
        else setActive(step(openMenu!.items, active, 1));
        break;
      case 'ArrowUp':
        if (open === null) show(current, step(all[current]!.items, 0, -1));
        else setActive(step(openMenu!.items, active < 0 ? 0 : active, -1));
        break;
      case 'Home':
        if (open === null) return;
        setActive(step(openMenu!.items, -1, 1));
        break;
      case 'End':
        if (open === null) return;
        setActive(step(openMenu!.items, 0, -1));
        break;
      case 'Enter':
      case ' ':
        // With an item highlighted the key chooses it; otherwise the title's own click toggles the menu.
        if (open === null || active < 0) return;
        run(openMenu!.items[active]!);
        break;
      case 'Escape':
        if (open === null) return;
        focusTrigger(open);
        close();
        break;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="menu-strip" ref={root} role="menubar" aria-label="Menus" onKeyDown={onKeyDown}>
      {all.map((menu, index) => {
        const isOpen = open === index;
        const menuId = `${baseId}-${menu.id}`;
        return (
          <div className="menu-strip__slot" key={menu.id}>
            <button
              ref={(node) => {
                triggers.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className={menu.content ? 'menu-strip__title menu-strip__title--mark' : 'menu-strip__title'}
              data-testid={`menu-${menu.id}`}
              data-open={isOpen || undefined}
              aria-label={menu.content ? menu.label : undefined}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={isOpen ? menuId : undefined}
              aria-activedescendant={isOpen && active >= 0 ? `${menuId}-${active}` : undefined}
              tabIndex={index === 0 ? 0 : -1}
              onClick={() => (isOpen ? close() : show(index))}
              onPointerEnter={() => {
                if (open !== null && !isOpen) show(index);
              }}
            >
              {menu.content ?? menu.label}
            </button>
            {/* The app's name follows the SpecOS menu; it names what the menus after it belong to. */}
            {index === 0 && (
              <span className="menu-strip__app" data-testid="active-app-name">
                {title}
              </span>
            )}
            <AnimatePresence>
              {isOpen && (
                <motion.div
                  key="popup"
                  id={menuId}
                  role="menu"
                  aria-label={menu.label}
                  className="menu-popup"
                  data-testid={`menu-${menu.id}-popup`}
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.08 } }}
                  transition={spring('menu')}
                  onPointerLeave={() => setActive(-1)}
                >
                  {menu.items.map((item, itemIndex) =>
                    item.separator ? (
                      <div key={itemIndex} role="separator" className="menu-popup__rule" />
                    ) : (
                      <div
                        key={itemIndex}
                        id={`${menuId}-${itemIndex}`}
                        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                        aria-checked={item.checked}
                        aria-disabled={item.disabled || undefined}
                        className="menu-popup__item"
                        data-active={active === itemIndex || undefined}
                        onPointerMove={() => {
                          if (selectable(item) && active !== itemIndex) setActive(itemIndex);
                        }}
                        onClick={() => run(item)}
                      >
                        <span className="menu-popup__check">{item.checked && <Glyph name="check" size={14} />}</span>
                        <span className="menu-popup__label">{item.label}</span>
                        {item.shortcut && <kbd className="menu-popup__shortcut">{item.shortcut}</kbd>}
                      </div>
                    ),
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
