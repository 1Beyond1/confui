# Confui

Point it at any project folder. It auto-detects JSON config files, infers what each
field means (via JSON Schema / known templates / heuristics / AI), and renders an
editable form UI — so you configure without reading the README.

## Architecture

```
project folder
  -> scanner (discover *.json / known configs)
  -> schema inference (3 tiers): JSON Schema -> known templates -> heuristics + AI
  -> Form Schema (shared contract)
  -> Web UI form  ->  save back to JSON
```

The AI tier (optional) reads the JSON + README and enriches field descriptions for
arbitrary projects. Provider is configurable (OpenAI-compatible: official OpenAI,
OpenRouter, DeepSeek, local Ollama, etc.) via Settings.

## Dev

```bash
npm install
npm run dev          # server (Fastify :7321) + web (Vite)
```
