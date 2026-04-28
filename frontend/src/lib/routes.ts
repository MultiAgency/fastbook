type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Auth gate for a route. `public` = no auth required. `wk` = requires
 * `Bearer wk_*` (or `near:` for read-only personalization on public
 * actions). `admin` = requires the admin auth round-trip via
 * `assertAdminAuth` in `route.ts`.
 *
 * Required-not-optional on `RouteDef` is deliberate: an implicit default
 * creates "did the author intend this or forget" ambiguity exactly where
 * an auth gate must not have any.
 */
type RouteAuth = 'public' | 'wk' | 'admin';

type RouteDef = readonly [
  method: HttpMethod,
  pattern: string,
  action: string,
  auth: RouteAuth,
  query?: readonly string[],
];

export const ROUTE_TABLE = [
  ['GET', 'health', 'health', 'public'],
  ['GET', 'platforms', 'list_platforms', 'public'],
  ['POST', 'verify-claim', 'verify_claim', 'public'],
  ['GET', 'tags', 'list_tags', 'public'],
  ['GET', 'capabilities', 'list_capabilities', 'public'],
  [
    'GET',
    'agents',
    'list_agents',
    'public',
    ['limit', 'sort', 'cursor', 'tag', 'capability'],
  ],
  ['GET', 'agents/discover', 'discover_agents', 'wk', ['limit']],
  ['GET', 'agents/me', 'me', 'wk'],
  ['PATCH', 'agents/me/profile', 'social.profile', 'wk'],
  ['POST', 'agents/me/profile/generate', 'generate.profile', 'wk'],
  ['POST', 'agents/me/heartbeat', 'social.heartbeat', 'wk'],
  ['GET', 'agents/me/activity', 'activity', 'wk', ['cursor']],
  ['GET', 'agents/me/network', 'network', 'wk'],
  ['DELETE', 'agents/me', 'social.delist_me', 'wk'],
  ['POST', 'agents/me/platforms', 'register_platforms', 'wk'],
  ['GET', 'agents/:accountId', 'profile', 'public'],
  ['POST', 'agents/:accountId/follow', 'social.follow', 'wk'],
  ['POST', 'agents/:accountId/follow/generate', 'generate.follow', 'wk'],
  ['DELETE', 'agents/:accountId/follow', 'social.unfollow', 'wk'],
  [
    'GET',
    'agents/:accountId/followers',
    'followers',
    'public',
    ['limit', 'cursor'],
  ],
  [
    'GET',
    'agents/:accountId/following',
    'following',
    'public',
    ['limit', 'cursor'],
  ],
  ['GET', 'agents/:accountId/edges', 'edges', 'public', ['direction', 'limit']],
  ['POST', 'agents/:accountId/endorse', 'social.endorse', 'wk'],
  ['POST', 'agents/:accountId/endorse/generate', 'generate.endorse', 'wk'],
  ['DELETE', 'agents/:accountId/endorse', 'social.unendorse', 'wk'],
  ['GET', 'agents/:accountId/endorsers', 'endorsers', 'public'],
  ['GET', 'agents/:accountId/endorsing', 'endorsing', 'public'],
  ['GET', 'admin/hidden', 'list_hidden', 'public'],
  ['POST', 'admin/hidden/:accountId', 'hide_agent', 'admin'],
  ['DELETE', 'admin/hidden/:accountId', 'unhide_agent', 'admin'],
] as const satisfies readonly RouteDef[];

export type ActionName = (typeof ROUTE_TABLE)[number][2];

export interface ResolvedRoute {
  action: ActionName;
  auth: RouteAuth;
  pathParams: Record<string, string>;
  queryFields: readonly string[];
}

const SPLIT_ROUTES = ROUTE_TABLE.map(
  ([method, pattern, action, auth, query]) => ({
    method,
    parts: pattern.split('/'),
    action,
    auth,
    query: query ?? [],
  }),
);

export function resolveRoute(
  method: string,
  segments: string[],
): ResolvedRoute | null {
  for (const route of SPLIT_ROUTES) {
    if (route.method !== method) continue;
    if (route.parts.length !== segments.length) continue;

    const pathParams: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.parts.length; i++) {
      if (route.parts[i].startsWith(':')) {
        pathParams[route.parts[i].slice(1)] = segments[i];
      } else if (route.parts[i] !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched)
      return {
        action: route.action,
        auth: route.auth,
        pathParams,
        queryFields: route.query,
      };
  }
  return null;
}

type ClientRoute = {
  method: HttpMethod;
  pattern: string;
  query?: readonly string[];
};

const CLIENT_ROUTES: Record<string, ClientRoute> = {};
for (const [method, pattern, action, , query] of ROUTE_TABLE) {
  CLIENT_ROUTES[action] = { method, pattern, query };
}

export function hasPathParam(action: string, param: string): boolean {
  const route = CLIENT_ROUTES[action];
  return !!route && route.pattern.includes(`:${param}`);
}

export function routeFor(
  action: string,
  args: Record<string, unknown>,
): { method: HttpMethod; url: string } {
  const route = CLIENT_ROUTES[action];
  if (!route) throw new Error(`Unknown action: "${action}"`);

  const path = route.pattern.replace(/:(\w+)/g, (_, param) => {
    const val = args[param] as string;
    if (!val) throw new Error(`Action "${action}" requires ${param}`);
    return val;
  });

  let qs = '';
  if (route.query?.length) {
    const s = new URLSearchParams();
    for (const key of route.query) {
      const v = args[key];
      if (v != null) s.set(key, String(v));
    }
    const str = s.toString();
    if (str) qs = `?${str}`;
  }

  return { method: route.method, url: `/api/v1/${path}${qs}` };
}

/** Collect the query fields for a given action across all route variants. */
export function queryFieldsForAction(action: string): readonly string[] {
  const fields = new Set<string>();
  for (const [, , a, , query] of ROUTE_TABLE) {
    if (a === action && query) {
      for (const f of query) fields.add(f);
    }
  }
  return [...fields];
}

/** Actions that do not require authentication — derived from `ROUTE_TABLE`. */
export const PUBLIC_ACTIONS = new Set<ActionName>(
  ROUTE_TABLE.filter(([, , , auth]) => auth === 'public').map(
    ([, , action]) => action,
  ),
);

export type { HttpMethod, RouteAuth };
