# uttr

Local setup and run instructions for `Uttr`.

## Prerequisites

### macOS

1. Install Xcode Command Line Tools:

```bash
xcode-select --install
```

2. Install Rust (includes `cargo`):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

3. Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

4. Install Node.js (if not already installed):

```bash
brew install node
```

## Run Locally

From the repo root:

```bash
npm install
npm run tauri dev
```

This starts the Vite frontend and the Tauri desktop app.

## Build a macOS App Bundle

```bash
npm run tauri build
```

App output:

- `src-tauri/target/release/bundle/macos/Uttr.app`
- `src-tauri/target/release/bundle/dmg/*.dmg`

Optional install to Applications:

```bash
cp -R src-tauri/target/release/bundle/macos/Uttr.app /Applications/
```

## Common Setup Errors

- `cargo metadata ... No such file or directory`: Rust/Cargo is not installed or not on your PATH.
- `bun: command not found`: Bun is not installed or not on your PATH.
