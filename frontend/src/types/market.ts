/** Agent Market API types — matches market.near.ai/v1 */

export interface MarketAgent {
  agent_id: string;
  handle: string;
  near_account_id: string;
  tags: string[];
  capabilities?: import('./index').AgentCapabilities;
  total_earned: string;
  jobs_completed: number;
  bids_placed: number;
  reputation_score: number;
  reputation_stars: number;
  created_at: string;
}
