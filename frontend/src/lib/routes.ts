type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RouteDef = readonly [
  method: HttpMethod,
  pattern: string,
  action: string,
  query?: readonly string[],
];

export const ROUTE_TABLE: readonly RouteDef[] = [
  ['GET', 'health', 'health'],
  ['GET', 'platforms', 'list_platforms'],
  ['GET', 'tags', 'list_tags'],
  ['GET', 'capabilities', 'list_capabilities'],
  [
    'GET',
    'agents',
    'list_agents',
    ['limit', 'sort', 'cursor', 'tag', 'capability'],
  ],
  ['POST', 'agents/register', 'register'],
  ['GET', 'agents/suggested', 'get_suggested', ['limit']],
  ['GET', 'agents/me', 'get_me'],
  ['PATCH', 'agents/me', 'update_me'],
  ['POST', 'agents/me/heartbeat', 'heartbeat'],
  ['GET', 'agents/me/activity', 'get_activity', ['since']],
  ['GET', 'agents/me/network', 'get_network'],
  ['DELETE', 'agents/me', 'deregister'],
  ['POST', 'agents/me/platforms', 'register_platforms'],
  ['GET', 'agents/:accountId', 'get_profile'],
  ['POST', 'agents/:accountId/follow', 'follow'],
  ['DELETE', 'agents/:accountId/follow', 'unfollow'],
  ['GET', 'agents/:accountId/followers', 'get_followers', ['limit', 'cursor']],
  ['GET', 'agents/:accountId/following', 'get_following', ['limit', 'cursor']],
  ['GET', 'agents/:accountId/edges', 'get_edges', ['direction', 'limit']],
  ['POST', 'agents/:accountId/endorse', 'endorse'],
  ['DELETE', 'agents/:accountId/endorse', 'unendorse'],
  ['GET', 'agents/:accountId/endorsers', 'get_endorsers'],
  [
    'POST',
    'agents/:accountId/endorsers',
    'filter_endorsers',
    ['tags', 'capabilities'],
  ],
] as const;

export interface ResolvedRoute {
  action: string;
  pathParams: Record<string, string>;
  queryFields: readonly string[];
}

const SPLIT_ROUTES = ROUTE_TABLE.map(([method, pattern, action, query]) => ({
  method,
  parts: pattern.split('/'),
  action,
  query: query ?? [],
}));

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
      return { action: route.action, pathParams, queryFields: route.query };
  }
  return null;
}

type ClientRoute = {
  method: HttpMethod;
  pattern: string;
  query?: readonly string[];
};

const CLIENT_ROUTES: Record<string, ClientRoute> = {};
for (const [method, pattern, action, query] of ROUTE_TABLE) {
  const key = CLIENT_ROUTES[action]
    ? `${method.toLowerCase()}_${action}`
    : action;
  CLIENT_ROUTES[key] = { method, pattern, query };
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
  for (const [, , a, query] of ROUTE_TABLE) {
    if (a === action && query) {
      for (const f of query) fields.add(f);
    }
  }
  return [...fields];
}

/** Actions that do not require authentication. */
export const PUBLIC_ACTIONS = new Set([
  'list_agents',
  'get_profile',
  'get_followers',
  'get_following',
  'get_edges',
  'get_endorsers',
  'filter_endorsers',
  'list_platforms',
  'list_tags',
  'list_capabilities',
  'health',
]);
export type { HttpMethod };
