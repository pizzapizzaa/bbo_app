/**
 * Grade tags and walls as the leaderboard page shows them. No server imports,
 * so both the page's components and its browser scripts can use this.
 *
 * Grades are the gym's hexagon tags — keep them hexagons. Points must match
 * GRADE_POINTS in src/pages/api/public/leaderboard.ts.
 */

export interface GradeTag {
  grade: string;
  bg:    string;   // tag colour
  fg:    string;   // text colour on the tag
  pts:   number;
}

export const GRADES: GradeTag[] = [
  { grade: 'V0', bg: '#FFFFFF', fg: '#000000', pts: 10  },
  { grade: 'V1', bg: '#EAB308', fg: '#000000', pts: 15  },
  { grade: 'V2', bg: '#F97316', fg: '#FFFFFF', pts: 20  },
  { grade: 'V3', bg: '#22C55E', fg: '#FFFFFF', pts: 25  },
  { grade: 'V4', bg: '#3B82F6', fg: '#FFFFFF', pts: 40  },
  { grade: 'V5', bg: '#EF4444', fg: '#FFFFFF', pts: 60  },
  { grade: 'V6', bg: '#EC4899', fg: '#FFFFFF', pts: 80  },
  { grade: 'V7', bg: '#9CA3AF', fg: '#111827', pts: 100 },
  { grade: 'V8', bg: '#111827', fg: '#FFFFFF', pts: 130 },
];

/** Wall codes with the names staff use (same as the POS Schedule page). */
export const WALL_NAMES: Array<{ code: string; name: string }> = [
  { code: 'W1', name: 'Overhang 20' },
  { code: 'W2', name: 'Vertical' },
  { code: 'W3', name: 'Overhang 10' },
  { code: 'W4', name: 'Cave 60' },
  { code: 'W5', name: 'Overhang 40' },
  { code: 'W6', name: 'Slab' },
];

/** Markup for a hexagon grade tag (styled by .hex-tag in leaderboard.css). */
export function hexTagHtml(g: GradeTag, label: string = g.grade, size = ''): string {
  return `<span class="hex-tag${size ? ` hex-tag--${size}` : ''}" ` +
    `style="--hex-bg:${g.bg};--hex-fg:${g.fg}">` +
    `<span class="hex-tag__face">${label}</span></span>`;
}
