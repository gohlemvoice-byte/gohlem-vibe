'use strict';

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    // Let pg parse SSL settings from the connection string itself.
    // Railway's internal Postgres URL does not require explicit ssl config.
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function init() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS call_transcripts (
      id             SERIAL PRIMARY KEY,
      call_sid       TEXT NOT NULL,
      restaurant     TEXT,
      started_at     TIMESTAMPTZ NOT NULL,
      duration_sec   NUMERIC(10,1),
      item_count     INTEGER,
      total_dollars  NUMERIC(10,2),
      avg_latency_ms INTEGER,
      transcript     JSONB NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function save({ callSid, restaurant, startTime, duration, items, total, transcript }) {
  const db = getPool();
  const latencies = transcript.filter(t => t.role === 'ai' && t.latencyMs).map(t => t.latencyMs);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  await db.query(
    `INSERT INTO call_transcripts
       (call_sid, restaurant, started_at, duration_sec, item_count, total_dollars, avg_latency_ms, transcript)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [callSid, restaurant, new Date(startTime), duration, items, total, avgLatency, JSON.stringify(transcript)]
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

module.exports = { init, save, getRecent };
