# Gohlem.ai

AI-powered restaurant phone ordering platform. Customers call in, speak naturally, and an AI voice agent takes their order — routing it directly to the POS system.

## Project Structure

```
gohlem-ai/
├── src/
│   ├── menu/        # Menu ingestion and storage
│   ├── rules/       # Rules engine
│   ├── orders/      # Order state management
│   ├── pos/         # POS connectors
│   ├── voice/       # Voice pipeline
│   └── dashboard/   # REST API layer
├── config/          # Environment and app configuration
└── tests/           # Automated test suites
```

### `src/menu`
Handles loading, parsing, and storing restaurant menus. Fetches menu data from the POS (e.g., Toast) and caches it so the AI can answer questions about items, modifiers, and prices.

### `src/rules`
Rules engine that encodes restaurant-specific business logic: upsell triggers, item substitution policies, time-based availability (e.g., lunch menu only before 3 pm), combo pricing, and order validation constraints.

### `src/orders`
Manages the full lifecycle of an order: building the cart during a call, validating it against the menu and rules, finalizing it, and tracking its status after submission to the POS.

### `src/pos`
Connector layer for Point-of-Sale systems. Currently targets the Toast POS API (OAuth, menu sync, order submission). Designed to be extended with additional POS providers (Square, Olo, etc.).

### `src/voice`
End-to-end voice pipeline: receives inbound phone calls via Twilio, transcribes speech with Deepgram STT, runs dialogue through an OpenAI LLM, and synthesizes responses back to the caller with TTS.

### `src/dashboard`
Express REST API consumed by the operator dashboard. Exposes endpoints for live call monitoring, order history, menu management, and system health.

### `config`
Centralizes all environment variable loading and app-level configuration (database connection, Redis client, feature flags). All other modules import from here — never directly from `process.env`.

### `tests`
Jest test suites organized to mirror `src/`. Includes unit tests for the rules engine and order logic, integration tests for POS connectors, and end-to-end call-flow tests.

## Getting Started

```bash
cp .env.example .env      # fill in your credentials
npm install
npm run dev
```

## Environment Variables

See [`.env.example`](.env.example) for all required variables.
