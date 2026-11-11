import { AnimatePresence, motion } from 'motion/react';
import { spring } from '../../design/motion';
import { useWindowsStore } from './store';

/**
 * The outline of where a dragged window will land: a half, a quarter, the
 * whole screen, or another tile. It grows out of its own middle and then
 * follows the pointer from zone to zone.
 */
export function DropPreview() {
  const rect = useWindowsStore((state) => state.dropPreview);
  const desktop = useWindowsStore((state) => state.desktop);
  // Just under the window being dragged, which is always the one in front.
  const z = useWindowsStore((state) => Math.max(0, ...Object.values(state.windows).map((win) => win.z)) - 1);

  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          className="wm-drop"
          data-testid="drop-preview"
          style={{ zIndex: z, left: `${desktop * 100}%` }}
          initial={{ opacity: 0, x: rect.x + rect.w * 0.04, y: rect.y + rect.h * 0.04, width: rect.w * 0.92, height: rect.h * 0.92 }}
          animate={{ opacity: 1, x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={spring('layout')}
        >
          <span className="wm-drop__size tabular">
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
