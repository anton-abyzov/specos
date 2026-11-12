import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { spring } from '../../design/motion';

export interface ContextItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  danger?: boolean;
  action?: () => void;
}

interface ContextMenuProps {
  /** Where the pointer was, in viewport coordinates. */
  x: number;
  y: number;
  items: ContextItem[];
  onClose(): void;
}

const usable = (item: ContextItem | undefined): boolean => !!item && !item.separator && !item.disabled;

function step(items: ContextItem[], from: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (((from + direction * offset) % items.length) + items.length) % items.length;
    if (usable(items[index])) return index;
  }
  return -1;
}

/** The menu a right click opens. It lives on the desktop, not in the window, so a window edge never cuts it. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState({ left: x, top: y });

  // Keep the whole menu on screen: flip it to the other side of the pointer when it would not fit.
  useLayoutEffect(() => {
    const { offsetWidth: width, offsetHeight: height } = menu.current!;
    setPlace({
      left: x + width + 8 > window.innerWidth ? Math.max(8, x - width) : x,
      top: y + height + 8 > window.innerHeight ? Math.max(8, y - height) : y,
    });
    menu.current!.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const run = (item: ContextItem | undefined) => {
    if (!item || !usable(item)) return;
    onClose();
    item.action?.();
  };

  return createPortal(
    <motion.div
      ref={menu}
      className="files-menu"
      role="menu"
      aria-label="File actions"
      data-testid="files-menu"
      tabIndex={-1}
      style={place}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring('menu')}
      onContextMenu={(event) => event.preventDefault()}
      onPointerLeave={() => setActive(-1)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'ArrowDown') setActive(step(items, active, 1));
        else if (event.key === 'ArrowUp') setActive(step(items, active < 0 ? 0 : active, -1));
        else if (event.key === 'Home') setActive(step(items, -1, 1));
        else if (event.key === 'End') setActive(step(items, 0, -1));
        else if (event.key === 'Enter' || event.key === ' ') run(items[active]);
        else if (event.key === 'Escape' || event.key === 'Tab') onClose();
        else return;
        event.preventDefault();
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} role="separator" className="files-menu__rule" />
        ) : (
          <div
            key={index}
            role="menuitem"
            className="files-menu__item"
            aria-disabled={item.disabled || undefined}
            data-active={active === index || undefined}
            data-danger={item.danger || undefined}
            onPointerMove={() => {
              if (usable(item) && active !== index) setActive(index);
            }}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd className="files-menu__shortcut">{item.shortcut}</kbd>}
          </div>
        ),
      )}
    </motion.div>,
    document.body,
  );
}
