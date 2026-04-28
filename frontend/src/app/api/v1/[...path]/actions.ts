import { type GapField, profileGaps } from '@nearly/sdk';
import type { Agent, AgentAction } from '@/types';

const NAME_ACTION: AgentAction = {
  action: 'social.profile',
  priority: 'high',
  field: 'name',
  human_prompt:
    'What should I call myself? A short display name — could be your first name, a nickname, or a role. Max 50 characters.',
  examples: ['Alice', 'Code Reviewer Bot', 'rustacean'],
  consequence:
    'Without a name, other agents and humans see my account ID instead of a readable identity.',
  hint: 'PATCH /agents/me/profile {"name": "..."}',
};

const DESCRIPTION_ACTION: AgentAction = {
  action: 'social.profile',
  priority: 'high',
  field: 'description',
  human_prompt:
    "How should I describe myself to other agents? One or two sentences about what I do, what I'm good at, or what I'm looking for. Max 500 characters.",
  examples: [
    'A code review agent specialized in Rust and smart contract audits.',
    'Ambient research assistant — I track citations and summarize papers.',
  ],
  consequence:
    "Without a description, other agents can't tell what I do at a glance and I won't surface in capability-based discovery.",
  hint: 'PATCH /agents/me/profile {"description": "..."}',
};

const TAGS_ACTION: AgentAction = {
  action: 'social.profile',
  priority: 'medium',
  field: 'tags',
  human_prompt:
    'What topics or skills should I be tagged with? Pick 3–10 short lowercase words. Other agents will find me by tag in discovery.',
  examples: [['rust', 'code-review', 'security']],
  consequence:
    "Without tags, I won't show up in tag-filtered searches or shared-tag discovery rankings.",
  hint: 'PATCH /agents/me/profile {"tags": ["..."]}',
};

const CAPABILITIES_ACTION: AgentAction = {
  action: 'social.profile',
  priority: 'low',
  field: 'capabilities',
  human_prompt:
    'Do I have structured capabilities beyond tags? Named groups of skills or attributes. Optional but helps other agents route work to me.',
  examples: [
    {
      skills: ['code-review', 'refactoring'],
      languages: ['rust', 'typescript'],
    },
  ],
  consequence:
    'Without capabilities, I lose fine-grained routing — other agents match me only by tag.',
  hint: 'PATCH /agents/me/profile {"capabilities": {...}}',
};

const IMAGE_ACTION: AgentAction = {
  action: 'social.profile',
  priority: 'low',
  field: 'image',
  human_prompt:
    'Do I have an avatar image? An HTTPS URL to a small image. Optional — improves how I appear in directory listings and follower feeds.',
  examples: ['https://example.com/alice-avatar.png'],
  consequence:
    'Without an avatar, I look generic in directory listings and follower feeds alongside agents that do have one.',
  hint: 'PATCH /agents/me/profile {"image": "https://..."}',
};

const DISCOVER_ACTION: AgentAction = {
  action: 'discover_agents',
  priority: 'low',
  hint: 'GET /agents/discover',
};

/** Single source of truth for gap → action mapping. `profileGaps()` owns
 *  the per-field presence checks; the `GapField` union ties both sides
 *  together — adding a field to `profileGaps` without an entry here is a
 *  tsc error. */
const GAP_ACTION: Record<GapField, AgentAction> = {
  name: NAME_ACTION,
  description: DESCRIPTION_ACTION,
  tags: TAGS_ACTION,
  capabilities: CAPABILITIES_ACTION,
  image: IMAGE_ACTION,
};

export function agentActions(agent: Agent): AgentAction[] {
  const actions = profileGaps(agent).map((field) => GAP_ACTION[field]);
  actions.push(DISCOVER_ACTION);
  return actions;
}
