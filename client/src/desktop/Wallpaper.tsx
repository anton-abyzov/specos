import { memo, useMemo } from 'react';
import { buildContours } from './contours';
import './wallpaper.css';

/**
 * The generative wallpaper: soft colour washes under a survey map of contour
 * lines. It is static (no animation loop) and takes no props, so React never
 * renders it again after mount; themes recolour it through CSS variables.
 */
export const Wallpaper = memo(function Wallpaper() {
  const map = useMemo(() => buildContours(), []);
  return (
    <div className="wallpaper" data-testid="wallpaper" aria-hidden="true">
      <svg
        className="wallpaper__map"
        viewBox={`0 0 ${map.width} ${map.height}`}
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        focusable="false"
      >
        <path className="wallpaper__contour" d={map.minor} />
        <path className="wallpaper__contour wallpaper__contour--major" d={map.major} />
        {map.summits.map((summit) => (
          <g key={`${summit.x}-${summit.y}`} className="wallpaper__summit">
            <path d={`M${summit.x - 5} ${summit.y}h10M${summit.x} ${summit.y - 5}v10`} />
            <text x={summit.x + 10} y={summit.y + 4}>
              {summit.height}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
});
