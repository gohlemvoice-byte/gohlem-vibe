'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function init() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS call_transcripts (
      id               SERIAL PRIMARY KEY,
      call_sid         TEXT NOT NULL,
      restaurant       TEXT,
      started_at       TIMESTAMPTZ NOT NULL,
      duration_sec     NUMERIC(10,1),
      item_count       INTEGER,
      total_dollars    NUMERIC(10,2),
      avg_latency_ms   INTEGER,
      transcript       JSONB NOT NULL,
      cart_items       JSONB,
      prompt_tokens    INTEGER,
      completion_tokens INTEGER,
      retell_cost_usd  NUMERIC(10,4),
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add columns to tables created before these columns existed
  const alters = [
    `ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS cart_items        JSONB`,
    `ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS prompt_tokens     INTEGER`,
    `ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS completion_tokens INTEGER`,
    `ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS retell_cost_usd   NUMERIC(10,4)`,
  ];
  for (const sql of alters) await db.query(sql);
}

async function save({
  callSid,
  restaurant,
  startTime,
  duration,
  items,
  total,
  transcript,
  cartItems     = [],
  promptTokens  = null,
  completionTokens = null,
  retellCostUsd = null,
}) {
  const db = getPool();
  const latencies = transcript.filter(t => t.role === 'ai' && t.latencyMs).map(t => t.latencyMs);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  await db.query(
    `INSERT INTO call_transcripts
       (call_sid, restaurant, started_at, duration_sec, item_count, total_dollars,
        avg_latency_ms, transcript, cart_items, prompt_tokens, completion_tokens, retell_cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      callSid, restaurant, new Date(startTime), duration, items, total,
      avgLatency,
      JSON.stringify(transcript),
      JSON.stringify(cartItems),
      promptTokens  || null,
      completionTokens || null,
      retellCostUsd || null,
    ]
  );
}

async function updateRetellCost(callSid, retellCostUsd) {
  const db = getPool();
  await db.query(
    `UPDATE call_transcripts SET retell_cost_usd = $1 WHERE call_sid = $2`,
    [retellCostUsd, callSid]
  );
}

async function getRecent(limit = 50) {
  const db = getPool();
  const result = await db.query(
    `SELECT * FROM call_transcripts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = { init, save, updateRetellCost, getRecent };
