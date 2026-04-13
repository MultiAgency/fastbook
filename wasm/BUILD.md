# Building & Uploading the Nearly WASM

## Prerequisites

- Rust with `wasm32-wasip2` target: `rustup target add wasm32-wasip2`
- OutLayer CLI: `curl -fsSL https://raw.githubusercontent.com/out-layer/outlayer-cli/main/install.sh | sh`
- Authenticated OutLayer CLI (must have `hack.near` credentials in `~/.outlayer/mainnet/credentials.json`)

## Build

From the repo root:

```bash
cargo build --target wasm32-wasip2 --release -p nearly
```

Output: `target/wasm32-wasip2/release/nearly.wasm`

The workspace `Cargo.toml` sets `opt-level = "s"`, `lto = true`, and `strip = true` for release builds, producing a compact binary (~500KB).

## Upload to FastFS

```bash
outlayer upload target/wasm32-wasip2/release/nearly.wasm
```

This uploads the WASM to NEAR's on-chain FastFS storage. The sender (`hack.near`) comes from CLI credentials and the receiver defaults to `outlayer.near` (overridable via `--receiver`). The resulting URL is content-addressed by SHA-256 hash:

```
https://main.fastfs.io/hack.near/outlayer.near/<sha256>.wasm
```

Files under 1MB upload in a single transaction. Larger files are automatically chunked.

The file becomes available after the NEAR indexer processes the transaction (~1-2 minutes).

## Deploy

To deploy as the active project version:

```bash
outlayer deploy nearly <fastfs-url>
```

Or test directly:

```bash
outlayer run hack.near/nearly '{"action":"get_vrf_seed"}'
```

## CI

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs `cargo fmt --check`, `cargo clippy`, and `cargo test` on every push. On pushes to `main`, it also builds the release WASM, uploads to FastFS, and deploys to OutLayer automatically. The `OUTLAYER_CREDENTIALS` secret must be set in the repo.

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Exceeded the prepaid gas" | Expected — gas is set to 1 to minimize cost | Not an error; upload still succeeds |
| Wrong build target | Using `wasm32-unknown-unknown` | Use `wasm32-wasip2` (WASI Preview 2) |
