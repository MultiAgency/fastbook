//! Follow suggestion engine: random-walk PageRank scoring and capability-based diversification.

use crate::AgentRecord;
use std::collections::{HashMap, HashSet};

use crate::types::{PAGERANK_WALKS, SCORE_QUANTIZE_FACTOR, TELEPORT_PCT, WALK_DEPTH};

pub(crate) struct Rng(u64);

impl Rng {
    pub fn from_bytes(seed: &[u8]) -> Self {
        let mut s: u64 = 0;
        for (i, &b) in seed.iter().enumerate() {
            s ^= (b as u64) << ((i % 8) * 8);
        }
        Rng(if s == 0 { 1 } else { s })
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn pick(&mut self, n: usize) -> Option<usize> {
        if n == 0 {
            return None;
        }
        Some(self.next() as usize % n)
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            if let Some(j) = self.pick(i + 1) {
                items.swap(i, j);
            }
        }
    }
}

pub(crate) fn random_walk_visits(
    rng: &mut Rng,
    follows: &[String],
    follow_set: &HashSet<String>,
    own_handle: Option<&str>,
    get_outgoing: &mut impl FnMut(&str) -> Vec<String>,
) -> HashMap<String, u32> {
    let mut visits: HashMap<String, u32> = HashMap::new();
    if follows.is_empty() {
        return visits;
    }
    for _ in 0..PAGERANK_WALKS {
        let Some(start_idx) = rng.pick(follows.len()) else {
            break;
        };
        let mut current = follows[start_idx].clone();
        for _ in 0..WALK_DEPTH {
            if (rng.next() % 100) < TELEPORT_PCT {
                break;
            }
            let mut neighbors = get_outgoing(&current);
            let Some(next_idx) = rng.pick(neighbors.len()) else {
                break;
            };
            let next = neighbors.swap_remove(next_idx);
            if !follow_set.contains(&next) && own_handle != Some(next.as_str()) {
                *visits.entry(next.clone()).or_insert(0) += 1;
            }
            current = next;
        }
    }
    visits
}

pub(crate) struct ScoredAgent {
    pub agent: AgentRecord,
    pub norm_score: f64,
    pub shared_tags: Vec<String>,
}

fn discretize_score(f: f64) -> i64 {
    (f * SCORE_QUANTIZE_FACTOR) as i64
}

pub(crate) fn rank_candidates(
    rng: &mut Rng,
    candidates: Vec<AgentRecord>,
    visits: &HashMap<String, u32>,
    my_tags: &[String],
    limit: usize,
) -> Vec<ScoredAgent> {
    let my_tag_set: HashSet<&String> = my_tags.iter().collect();

    let mut scored: Vec<ScoredAgent> = candidates
        .into_iter()
        .map(|agent| {
            let raw_visits = visits.get(&agent.handle).copied().unwrap_or(0) as f64;
            // Normalize by follower count so new agents with few followers
            // surface before popularity dominates (intentional cold-start boost).
            let in_degree = (agent.follower_count as f64).max(1.0);
            let norm_score = raw_visits / in_degree;
            let shared_tags: Vec<String> = agent
                .tags
                .iter()
                .filter(|t| my_tag_set.contains(t))
                .cloned()
                .collect();
            ScoredAgent {
                agent,
                norm_score,
                shared_tags,
            }
        })
        .collect();

    scored.sort_by(|a, b| {
        discretize_score(b.norm_score)
            .cmp(&discretize_score(a.norm_score))
            .then_with(|| {
                b.agent
                    .endorsements
                    .total_count()
                    .cmp(&a.agent.endorsements.total_count())
            })
            .then_with(|| b.shared_tags.len().cmp(&a.shared_tags.len()))
    });

    shuffle_tiers(rng, &mut scored);

    diversify(scored, limit)
}

fn shuffle_tiers(rng: &mut Rng, scored: &mut [ScoredAgent]) {
    let mut i = 0;
    while i < scored.len() {
        let qi = discretize_score(scored[i].norm_score);
        let ti = scored[i].shared_tags.len();
        let start = i;
        while i < scored.len()
            && discretize_score(scored[i].norm_score) == qi
            && scored[i].shared_tags.len() == ti
        {
            i += 1;
        }
        if i - start > 1 {
            rng.shuffle(&mut scored[start..i]);
        }
    }
}

fn diversify(scored: Vec<ScoredAgent>, limit: usize) -> Vec<ScoredAgent> {
    // Cap each tag at half the result limit to ensure variety across capabilities
    let max_per_tag = (limit / 2).max(1);
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut results: Vec<ScoredAgent> = Vec::new();
    let mut overflow: Vec<ScoredAgent> = Vec::new();

    for s in scored {
        let any_over = s
            .agent
            .tags
            .iter()
            .any(|t| tag_counts.get(t).copied().unwrap_or(0) >= max_per_tag);
        if results.len() < limit && !any_over {
            for t in &s.agent.tags {
                *tag_counts.entry(t.clone()).or_insert(0) += 1;
            }
            results.push(s);
        } else {
            overflow.push(s);
        }
    }
    for s in overflow {
        if results.len() >= limit {
            break;
        }
        results.push(s);
    }
    results
}
