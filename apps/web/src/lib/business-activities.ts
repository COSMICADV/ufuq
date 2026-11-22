/**
 * 1to1OS Business — the activities offered on the Business page.
 *
 * One shared configuration, not eight applications: every activity is the
 * same Business workspace, set up with the core modules that matter most to
 * it. The id is what sign-up stores on the company
 * (`companies.business_activity`; the API and a database CHECK list the same
 * eight). Words come from the catalogue (`activity.*`).
 */

export const ACTIVITY_IDS = ['medical', 'food', 'clothing', 'perfume', 'fitness', 'beauty', 'retail', 'other'] as const;
export type ActivityId = (typeof ACTIVITY_IDS)[number];

/** The Business sections a subscription holds (the page's own five). */
export type ModuleKey = 'team' | 'tasks' | 'inventory' | 'reports' | 'pos';

export interface ActivityConfig {
  readonly id: ActivityId;
  /** The approved artwork, cut from the approved icon sheet. */
  readonly icon: string;
  /** Core modules this activity starts with, most relevant first. */
  readonly modules: readonly ModuleKey[];
  /** A further choice before sign-up (Medical: clinic or medical center). */
  readonly subtypes?: readonly string[];
}

export const ACTIVITIES: readonly ActivityConfig[] = [
  { id: 'medical', icon: '/brand/activities/medical.png', modules: ['team', 'tasks', 'inventory', 'reports'], subtypes: ['clinic', 'medical_center'] },
  { id: 'food', icon: '/brand/activities/food.png', modules: ['pos', 'inventory', 'team', 'reports'] },
  { id: 'clothing', icon: '/brand/activities/clothing.png', modules: ['pos', 'inventory', 'team', 'reports'] },
  { id: 'perfume', icon: '/brand/activities/perfume.png', modules: ['pos', 'inventory', 'team', 'reports'] },
  { id: 'fitness', icon: '/brand/activities/fitness.png', modules: ['team', 'tasks', 'pos', 'reports'] },
  { id: 'beauty', icon: '/brand/activities/beauty.png', modules: ['team', 'tasks', 'pos', 'reports'] },
  { id: 'retail', icon: '/brand/activities/retail.png', modules: ['pos', 'inventory', 'team', 'reports'] },
  { id: 'other', icon: '/brand/activities/other.png', modules: ['team', 'tasks', 'inventory', 'reports', 'pos'] },
];

export function activityById(id: string | null | undefined): ActivityConfig | null {
  return ACTIVITIES.find((a) => a.id === id) ?? null;
}

/** Where the chosen activity waits between the Business page and sign-up. */
export const ONBOARDING_KEY = 'ufuq.onboarding.activity';

export interface OnboardingChoice {
  readonly activity: ActivityId;
  readonly subtype: string | null;
}

/** A choice from `?activity=…&subtype=…`, validated against the configuration. */
export function readChoice(params: URLSearchParams): OnboardingChoice | null {
  const activity = activityById(params.get('activity'));
  if (!activity) return null;
  const subtype = params.get('subtype');
  return {
    activity: activity.id,
    subtype: subtype && activity.subtypes?.includes(subtype) ? subtype : null,
  };
}
