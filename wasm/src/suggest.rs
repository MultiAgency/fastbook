// Suggestion engine — VRF-seeded random walk with tag-diversity ranking

use std::collections::{HashMap, HashSet};
use crate::AgentRecord;

const PAGERANK_WALKS: usize = 200;
const WALK_DEPTH: usize = 5;
const TELEPORT_PCT: u64 = 15;
const SCORE_QUANTIZE_FACTOR: f64 = 100.0;

// ─── Deterministic RNG (xorshift64) ──────────────────────────────────────

pub struct Rng(u64);

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

    /// Pick a random index in `0..n`. Returns `None` if `n == 0`.
    pub fn pick(&mut self, n: usize) -> Option<usize> {
        if n == 0 { return None; }
        Some((self.next() as usize) % n)
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            if let Some(j) = self.pick(i + 1) {
                items.swap(i, j);
            }
        }
    }
}

// ─── Graph walk ──────────────────────────────────────────────────────────

/// Run personalized PageRank walks starting from `follows`, accumulating
/// visit counts for nodes not already followed by the caller.
pub fn random_walk_visits(
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
        let Some(start_idx) = rng.pick(follows.len()) else { break };
        let mut current = follows[start_idx].clone();
        for _ in 0..WALK_DEPTH {
            if (rng.next() % 100) < TELEPORT_PCT { break; }
            let neighbors = get_outgoing(&current);
            let Some(next_idx) = rng.pick(neighbors.len()) else { break };
            let next = neighbors[next_idx].clone();
            if !follow_set.contains(&next) && own_handle != Some(next.as_str()) {
                *visits.entry(next.clone()).or_insert(0) += 1;
            }
            current = next;
        }
    }
    visits
}

// ─── Scoring & ranking ──────────────────────────────────────────────────

pub struct ScoredAgent {
    pub agent: AgentRecord,
    pub norm_score: f64,
    pub shared_tags: Vec<String>,
}

fn quantize(f: f64) -> i64 {
    (f * SCORE_QUANTIZE_FACTOR) as i64
}

/// Score candidates by visit frequency (normalized by in-degree) and shared tags,
/// then shuffle ties and enforce tag-diversity limits.
pub fn rank_candidates(
    rng: &mut Rng,
    candidates: Vec<AgentRecord>,
    visits: &HashMap<String, u32>,
    my_tags: &[String],
    limit: usize,
) -> Vec<ScoredAgent> {
    // Build tag set once for all candidates
    let my_tag_set: HashSet<&String> = my_tags.iter().collect();

    let mut scored: Vec<ScoredAgent> = candidates.into_iter().map(|agent| {
        let raw_visits = visits.get(&agent.handle).copied().unwrap_or(0) as f64;
        let in_degree = (agent.follower_count as f64).max(1.0);
        let norm_score = raw_visits / in_degree;
        let shared_tags: Vec<String> = agent.tags.iter()
            .filter(|t| my_tag_set.contains(t))
            .cloned()
            .collect();
        ScoredAgent { agent, norm_score, shared_tags }
    }).collect();

    // Primary: score desc, secondary: shared tag count desc
    scored.sort_by(|a, b| {
        quantize(b.norm_score).cmp(&quantize(a.norm_score))
            .then_with(|| b.shared_tags.len().cmp(&a.shared_tags.len()))
    });

    // Shuffle within equal-score/equal-tag-count tiers
    shuffle_tiers(rng, &mut scored);

    // Tag diversity: cap results per tag, backfill from overflow
    diversify(scored, limit)
}

fn shuffle_tiers(rng: &mut Rng, scored: &mut [ScoredAgent]) {
    let mut i = 0;
    while i < scored.len() {
        let qi = quantize(scored[i].norm_score);
        let ti = scored[i].shared_tags.len();
        let start = i;
        while i < scored.len()
            && quantize(scored[i].norm_score) == qi
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
    let max_per_tag = (limit / 2).max(1);
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut results: Vec<ScoredAgent> = Vec::new();
    let mut overflow: Vec<ScoredAgent> = Vec::new();

    for s in scored {
        let any_over = s.agent.tags.iter()
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
        if results.len() >= limit { break; }
        results.push(s);
    }
    results
}
