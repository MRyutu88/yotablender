// Modifiers are plain data (never applied), named after Blender's Python properties so the
// Blender add-on can map them 1:1.

export interface MirrorModifier {
  type: 'MIRROR';
  name: string;
  show_viewport: boolean;
  use_axis: [boolean, boolean, boolean];
  use_clip: boolean;
  use_mirror_merge: boolean;
  merge_threshold: number;
}

export interface SubsurfModifier {
  type: 'SUBSURF';
  name: string;
  show_viewport: boolean;
  /** Viewport level (Blender's "Levels Viewport"). */
  levels: number;
  /** Render level, carried over to Blender. */
  render_levels: number;
  use_limit_surface: boolean;
  /** App-only: level used while a finger is dragging (keeps 60 fps on big cages). */
  drag_levels: number;
}

export type Modifier = MirrorModifier | SubsurfModifier;
export type ModifierType = Modifier['type'];

export const newMirror = (): MirrorModifier => ({
  type: 'MIRROR',
  name: 'Mirror',
  show_viewport: true,
  use_axis: [true, false, false],
  use_clip: true,
  use_mirror_merge: true,
  merge_threshold: 0.001,
});

export const newSubsurf = (): SubsurfModifier => ({
  type: 'SUBSURF',
  name: 'Subdivision',
  show_viewport: true,
  levels: 2,
  render_levels: 2,
  use_limit_surface: true,
  drag_levels: 2,
});

/** Blender's order for the M1 stack: Mirror before Subdivision. */
export function sortStack(mods: Modifier[]): Modifier[] {
  const rank = (m: Modifier) => (m.type === 'MIRROR' ? 0 : 1);
  return mods.slice().sort((a, b) => rank(a) - rank(b));
}
